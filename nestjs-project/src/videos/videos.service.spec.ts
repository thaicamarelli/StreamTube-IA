import { VideosService } from './videos.service';
import {
  ChannelNotFoundException,
  FileTooLargeException,
  ForbiddenNotOwnerException,
  IncompleteMultipartUploadException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_PROCESS_JOB_NAME } from './videos.constants';

const TEN_GB = 10 * 1024 * 1024 * 1024;

function makeChannel(id = 'channel-id') {
  return { id, name: 'chan', nickname: 'chan', user_id: 'user-id' };
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    channel_id: 'channel-id',
    title: null,
    original_filename: 'video.mp4',
    status: VideoStatus.DRAFT,
    storage_key: 'video-id',
    thumbnail_key: null,
    duration_seconds: null,
    upload_id: 'upload-id',
    error_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: undefined as any,
    processingEvents: [],
    ...overrides,
  };
}

function makeRepository(overrides: Record<string, jest.Mock> = {}): any {
  return {
    create: jest.fn((data) => data),
    save: jest.fn().mockResolvedValue(undefined),
    findOneBy: jest.fn().mockResolvedValue(makeVideo()),
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeChannelsService(overrides: Record<string, jest.Mock> = {}): any {
  return {
    findByUserId: jest.fn().mockResolvedValue(makeChannel()),
    ...overrides,
  };
}

function makeStorageService(overrides: Record<string, jest.Mock> = {}): any {
  return {
    videosBucket: 'videos',
    partSizeBytes: 100 * 1024 * 1024,
    partCountForSize: jest.fn().mockReturnValue(1),
    createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
    getPresignedPartUrls: jest
      .fn()
      .mockResolvedValue([{ partNumber: 1, url: 'https://signed-url' }]),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeQueue(overrides: Record<string, jest.Mock> = {}): any {
  return {
    add: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('VideosService', () => {
  describe('initiateUpload', () => {
    it('creates a draft video under the caller channel and returns presigned parts', async () => {
      const repository = makeRepository();
      const channelsService = makeChannelsService();
      const storageService = makeStorageService();
      const service = new VideosService(
        repository,
        channelsService,
        storageService,
        makeQueue(),
      );

      const result = await service.initiateUpload('user-id', {
        originalFilename: 'video.mp4',
        fileSizeBytes: 1024,
      });

      expect(channelsService.findByUserId).toHaveBeenCalledWith('user-id');
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-id',
          original_filename: 'video.mp4',
          upload_id: 'upload-id',
        }),
      );
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        'videos',
        result.id,
      );
      expect(result.uploadId).toBe('upload-id');
      expect(result.parts).toEqual([
        { partNumber: 1, url: 'https://signed-url' },
      ]);
      expect(result.partSizeBytes).toBe(storageService.partSizeBytes);
    });

    it('uses the generated video id as the storage_key (per TD-02)', async () => {
      const repository = makeRepository();
      const service = new VideosService(
        repository,
        makeChannelsService(),
        makeStorageService(),
        makeQueue(),
      );

      const result = await service.initiateUpload('user-id', {
        originalFilename: 'video.mp4',
        fileSizeBytes: 1024,
      });

      const created = repository.create.mock.calls[0][0] as Partial<Video>;
      expect(created.id).toBe(result.id);
      expect(created.storage_key).toBe(result.id);
    });

    it('accepts fileSizeBytes exactly at the 10GB limit', async () => {
      const repository = makeRepository();
      const service = new VideosService(
        repository,
        makeChannelsService(),
        makeStorageService(),
        makeQueue(),
      );

      await expect(
        service.initiateUpload('user-id', {
          originalFilename: 'video.mp4',
          fileSizeBytes: TEN_GB,
        }),
      ).resolves.toBeDefined();
    });

    it('throws FileTooLargeException when fileSizeBytes exceeds 10GB', async () => {
      const repository = makeRepository();
      const service = new VideosService(
        repository,
        makeChannelsService(),
        makeStorageService(),
        makeQueue(),
      );

      await expect(
        service.initiateUpload('user-id', {
          originalFilename: 'video.mp4',
          fileSizeBytes: TEN_GB + 1,
        }),
      ).rejects.toThrow(FileTooLargeException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('throws ChannelNotFoundException when the caller has no channel', async () => {
      const repository = makeRepository();
      const channelsService = makeChannelsService({
        findByUserId: jest.fn().mockResolvedValue(null),
      });
      const service = new VideosService(
        repository,
        channelsService,
        makeStorageService(),
        makeQueue(),
      );

      await expect(
        service.initiateUpload('user-id', {
          originalFilename: 'video.mp4',
          fileSizeBytes: 1024,
        }),
      ).rejects.toThrow(ChannelNotFoundException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('aborts the multipart upload when generating presigned part URLs fails', async () => {
      const repository = makeRepository();
      const storageService = makeStorageService({
        createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
        getPresignedPartUrls: jest
          .fn()
          .mockRejectedValue(new Error('storage unavailable')),
        abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      });
      const service = new VideosService(
        repository,
        makeChannelsService(),
        storageService,
        makeQueue(),
      );

      await expect(
        service.initiateUpload('user-id', {
          originalFilename: 'video.mp4',
          fileSizeBytes: 1024,
        }),
      ).rejects.toThrow('storage unavailable');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos',
        expect.any(String),
        'upload-id',
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('aborts the multipart upload when persisting the draft video fails', async () => {
      const repository = makeRepository({
        save: jest.fn().mockRejectedValue(new Error('db unavailable')),
      });
      const storageService = makeStorageService();
      const service = new VideosService(
        repository,
        makeChannelsService(),
        storageService,
        makeQueue(),
      );

      await expect(
        service.initiateUpload('user-id', {
          originalFilename: 'video.mp4',
          fileSizeBytes: 1024,
        }),
      ).rejects.toThrow('db unavailable');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos',
        expect.any(String),
        'upload-id',
      );
    });
  });

  describe('completeUpload', () => {
    const validDto = { parts: [{ partNumber: 1, eTag: '"etag-1"' }] };

    it('completes the multipart upload, marks the video processing, and enqueues the job', async () => {
      const repository = makeRepository();
      const storageService = makeStorageService();
      const queue = makeQueue();
      const service = new VideosService(
        repository,
        makeChannelsService(),
        storageService,
        queue,
      );

      await service.completeUpload('user-id', 'video-id', validDto);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos',
        'video-id',
        'upload-id',
        validDto.parts,
      );
      expect(repository.update).toHaveBeenCalledWith('video-id', {
        status: VideoStatus.PROCESSING,
      });
      expect(queue.add).toHaveBeenCalledWith(VIDEO_PROCESS_JOB_NAME, {
        videoId: 'video-id',
      });

      const addOrder = queue.add.mock.invocationCallOrder[0];
      const updateOrder = repository.update.mock.invocationCallOrder[0];
      expect(addOrder).toBeLessThan(updateOrder);
    });

    it('leaves the video in draft and does not update status when enqueueing the job fails', async () => {
      const repository = makeRepository();
      const storageService = makeStorageService();
      const queue = makeQueue({
        add: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      });
      const service = new VideosService(
        repository,
        makeChannelsService(),
        storageService,
        queue,
      );

      await expect(
        service.completeUpload('user-id', 'video-id', validDto),
      ).rejects.toThrow('redis unavailable');

      expect(repository.update).not.toHaveBeenCalled();
    });

    it('throws VideoNotFoundException when the video does not exist', async () => {
      const repository = makeRepository({
        findOneBy: jest.fn().mockResolvedValue(null),
      });
      const service = new VideosService(
        repository,
        makeChannelsService(),
        makeStorageService(),
        makeQueue(),
      );

      await expect(
        service.completeUpload('user-id', 'missing-id', validDto),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws ForbiddenNotOwnerException when the caller does not own the video channel', async () => {
      const repository = makeRepository();
      const channelsService = makeChannelsService({
        findByUserId: jest
          .fn()
          .mockResolvedValue(makeChannel('someone-elses-channel-id')),
      });
      const service = new VideosService(
        repository,
        channelsService,
        makeStorageService(),
        makeQueue(),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', validDto),
      ).rejects.toThrow(ForbiddenNotOwnerException);
    });

    it('throws ForbiddenNotOwnerException when the caller has no channel at all', async () => {
      const repository = makeRepository();
      const channelsService = makeChannelsService({
        findByUserId: jest.fn().mockResolvedValue(null),
      });
      const service = new VideosService(
        repository,
        channelsService,
        makeStorageService(),
        makeQueue(),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', validDto),
      ).rejects.toThrow(ForbiddenNotOwnerException);
    });

    it('throws UploadAlreadyCompletedException when the video is not in draft', async () => {
      const repository = makeRepository({
        findOneBy: jest
          .fn()
          .mockResolvedValue(makeVideo({ status: VideoStatus.PROCESSING })),
      });
      const service = new VideosService(
        repository,
        makeChannelsService(),
        makeStorageService(),
        makeQueue(),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', validDto),
      ).rejects.toThrow(UploadAlreadyCompletedException);
    });

    it('throws IncompleteMultipartUploadException and does not advance state when storage rejects the parts', async () => {
      const repository = makeRepository();
      const storageService = makeStorageService({
        completeMultipartUpload: jest
          .fn()
          .mockRejectedValue(new Error('mismatched parts')),
      });
      const queue = makeQueue();
      const service = new VideosService(
        repository,
        makeChannelsService(),
        storageService,
        queue,
      );

      await expect(
        service.completeUpload('user-id', 'video-id', validDto),
      ).rejects.toThrow(IncompleteMultipartUploadException);

      expect(repository.update).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
