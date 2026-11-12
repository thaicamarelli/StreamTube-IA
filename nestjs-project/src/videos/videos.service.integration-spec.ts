import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { randomUUID } from 'node:crypto';
import { ChannelsService } from '../channels/channels.service';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingEvent } from './entities/video-processing-event.entity';
import { VideosService } from './videos.service';
import {
  ChannelNotFoundException,
  ForbiddenNotOwnerException,
  IncompleteMultipartUploadException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESS_JOB_NAME,
} from './videos.constants';
import type { VideoProcessJobData } from './video-processing.consumer';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  VideoProcessingEvent,
];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let queue: Queue<VideoProcessJobData>;
  let videosService: VideosService;
  let module: TestingModule;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    channelsService = new ChannelsService(dataSource, channelRepository);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        BullModule.forRoot({
          connection: {
            host: process.env.QUEUE_REDIS_HOST || 'redis',
            port: Number(process.env.QUEUE_REDIS_PORT || 6379),
          },
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [StorageService],
    }).compile();
    storageService = module.get(StorageService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));

    videosService = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      queue,
    );
  });

  afterAll(async () => {
    await module.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  let counter = 0;
  async function createUserAndChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(
      user.id,
      `videos_svc_${n}@example.com`,
    );
    return { userId: user.id, channelId: channel.id };
  }

  async function createDraftWithUploadedPart(): Promise<{
    userId: string;
    channelId: string;
    videoId: string;
    eTag: string;
  }> {
    const { userId, channelId } = await createUserAndChannel();
    const initiated = await videosService.initiateUpload(userId, {
      originalFilename: 'integration-complete.mp4',
      fileSizeBytes: 1024,
    });
    const putResponse = await fetch(initiated.parts[0].url, {
      method: 'PUT',
      body: Buffer.from('integration test content'),
    });
    const eTag = putResponse.headers.get('etag')!;
    return { userId, channelId, videoId: initiated.id, eTag };
  }

  it('persists a draft Video with a real multipart upload against MinIO', async () => {
    const { userId, channelId } = await createUserAndChannel();

    const result = await videosService.initiateUpload(userId, {
      originalFilename: 'integration-video.mp4',
      fileSizeBytes: 2048,
    });

    expect(result.uploadId).toBeTruthy();
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].url).toContain('X-Amz-Signature');

    const persisted = await videoRepository.findOneBy({ id: result.id });
    expect(persisted?.channel_id).toBe(channelId);
    expect(persisted?.original_filename).toBe('integration-video.mp4');
    expect(persisted?.status).toBe('draft');
    expect(persisted?.storage_key).toBe(result.id);
    expect(persisted?.upload_id).toBe(result.uploadId);
  });

  it('rejects a declared file size above the 10GB limit without creating a row', async () => {
    const { userId } = await createUserAndChannel();

    await expect(
      videosService.initiateUpload(userId, {
        originalFilename: 'huge.mp4',
        fileSizeBytes: 10 * 1024 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow();

    const count = await videoRepository.count();
    expect(count).toBe(0);
  });

  it('throws ChannelNotFoundException for an authenticated user with no channel, without creating a row', async () => {
    const orphanUserId = randomUUID();

    await expect(
      videosService.initiateUpload(orphanUserId, {
        originalFilename: 'orphan.mp4',
        fileSizeBytes: 2048,
      }),
    ).rejects.toThrow(ChannelNotFoundException);

    const count = await videoRepository.count();
    expect(count).toBe(0);
  });

  describe('completeUpload', () => {
    it('completes a real multipart upload, marks the video processing, and enqueues exactly one job', async () => {
      const { userId, videoId, eTag } = await createDraftWithUploadedPart();

      await videosService.completeUpload(userId, videoId, {
        parts: [{ partNumber: 1, eTag }],
      });

      const persisted = await videoRepository.findOneBy({ id: videoId });
      expect(persisted?.status).toBe(VideoStatus.PROCESSING);

      const waitingJobs = await queue.getJobs(['waiting', 'completed']);
      const matching = waitingJobs.filter(
        (job) =>
          job.name === VIDEO_PROCESS_JOB_NAME && job.data.videoId === videoId,
      );
      expect(matching).toHaveLength(1);
    });

    it('throws VideoNotFoundException for a nonexistent video', async () => {
      const { userId } = await createUserAndChannel();

      await expect(
        videosService.completeUpload(userId, randomUUID(), {
          parts: [{ partNumber: 1, eTag: '"irrelevant"' }],
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws ForbiddenNotOwnerException when called by a different channel owner', async () => {
      const { videoId, eTag } = await createDraftWithUploadedPart();
      const { userId: otherUserId } = await createUserAndChannel();

      await expect(
        videosService.completeUpload(otherUserId, videoId, {
          parts: [{ partNumber: 1, eTag }],
        }),
      ).rejects.toThrow(ForbiddenNotOwnerException);
    });

    it('throws UploadAlreadyCompletedException when completed twice', async () => {
      const { userId, videoId, eTag } = await createDraftWithUploadedPart();
      await videosService.completeUpload(userId, videoId, {
        parts: [{ partNumber: 1, eTag }],
      });

      await expect(
        videosService.completeUpload(userId, videoId, {
          parts: [{ partNumber: 1, eTag }],
        }),
      ).rejects.toThrow(UploadAlreadyCompletedException);
    });

    it('throws IncompleteMultipartUploadException and leaves the video in draft when parts do not match', async () => {
      const { userId, videoId } = await createDraftWithUploadedPart();

      await expect(
        videosService.completeUpload(userId, videoId, {
          parts: [{ partNumber: 1, eTag: '"not-the-real-etag"' }],
        }),
      ).rejects.toThrow(IncompleteMultipartUploadException);

      const persisted = await videoRepository.findOneBy({ id: videoId });
      expect(persisted?.status).toBe(VideoStatus.DRAFT);
    });
  });
});
