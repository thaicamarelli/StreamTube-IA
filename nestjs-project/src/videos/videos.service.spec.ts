import { VideosService } from './videos.service';
import { FileTooLargeException } from './exceptions/video.exceptions';
import { Video } from './entities/video.entity';

function makeChannel(id = 'channel-id') {
  return { id, name: 'chan', nickname: 'chan', user_id: 'user-id' };
}

function makeRepository(overrides: Record<string, jest.Mock> = {}): any {
  return {
    create: jest.fn((data) => data),
    save: jest.fn().mockResolvedValue(undefined),
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
        }),
      );
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        'videos',
        result.id,
      );
      expect(repository.update).toHaveBeenCalledWith(result.id, {
        upload_id: 'upload-id',
      });
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
      );

      const result = await service.initiateUpload('user-id', {
        originalFilename: 'video.mp4',
        fileSizeBytes: 1024,
      });

      const created = repository.create.mock.calls[0][0] as Partial<Video>;
      expect(created.id).toBe(result.id);
      expect(created.storage_key).toBe(result.id);
    });

    it('throws FileTooLargeException when fileSizeBytes exceeds 10GB', async () => {
      const repository = makeRepository();
      const service = new VideosService(
        repository,
        makeChannelsService(),
        makeStorageService(),
      );

      await expect(
        service.initiateUpload('user-id', {
          originalFilename: 'video.mp4',
          fileSizeBytes: 10 * 1024 * 1024 * 1024 + 1,
        }),
      ).rejects.toThrow(FileTooLargeException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('throws when the caller has no channel', async () => {
      const repository = makeRepository();
      const channelsService = makeChannelsService({
        findByUserId: jest.fn().mockResolvedValue(null),
      });
      const service = new VideosService(
        repository,
        channelsService,
        makeStorageService(),
      );

      await expect(
        service.initiateUpload('user-id', {
          originalFilename: 'video.mp4',
          fileSizeBytes: 1024,
        }),
      ).rejects.toThrow();
      expect(repository.create).not.toHaveBeenCalled();
    });
  });
});
