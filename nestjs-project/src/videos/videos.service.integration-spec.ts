import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoProcessingEvent } from './entities/video-processing-event.entity';
import { VideosService } from './videos.service';

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
  let videosService: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    channelsService = new ChannelsService(dataSource, channelRepository);

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();
    storageService = module.get(StorageService);

    videosService = new VideosService(
      videoRepository,
      channelsService,
      storageService,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
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
});
