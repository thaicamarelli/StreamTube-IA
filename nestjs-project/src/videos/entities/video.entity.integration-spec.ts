import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Video, VideoStatus } from './video.entity';
import { VideoProcessingEvent } from './video-processing-event.entity';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  VideoProcessingEvent,
];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `chan_${n}`,
        user_id: user.id,
      }),
    );
  }

  it('should default status to draft and allow nullable fields', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_filename: 'video.mp4',
        storage_key: 'storage-key-1',
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.title).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.error_reason).toBeNull();
  });

  it('should enforce unique storage_key constraint', async () => {
    const channel = await createChannel();

    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_filename: 'a.mp4',
        storage_key: 'duplicate-key',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          original_filename: 'b.mp4',
          storage_key: 'duplicate-key',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce unique thumbnail_key constraint when set', async () => {
    const channel = await createChannel();

    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_filename: 'a.mp4',
        storage_key: 'key-a',
        thumbnail_key: 'duplicate-thumb',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          original_filename: 'b.mp4',
          storage_key: 'key-b',
          thumbnail_key: 'duplicate-thumb',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject an invalid status value', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("channel_id", "original_filename", "storage_key", "status")
         VALUES ($1, $2, $3, $4)`,
        [channel.id, 'a.mp4', 'key-invalid', 'not-a-status'],
      ),
    ).rejects.toThrow();
  });

  it('should fail with invalid channel_id due to FK violation', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          original_filename: 'a.mp4',
          storage_key: 'key-fk',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_filename: 'a.mp4',
        storage_key: 'key-rel',
      }),
    );

    const found = await videoRepository.findOne({
      where: { storage_key: 'key-rel' },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
