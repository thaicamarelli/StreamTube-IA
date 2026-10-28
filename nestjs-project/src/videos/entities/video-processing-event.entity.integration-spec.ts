import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Video } from './video.entity';
import {
  VideoProcessingEvent,
  VideoProcessingEventStatus,
} from './video-processing-event.entity';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  VideoProcessingEvent,
];

describe('VideoProcessingEvent entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let eventRepository: Repository<VideoProcessingEvent>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    eventRepository = dataSource.getRepository(VideoProcessingEvent);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createVideo(): Promise<Video> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `event_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `event_chan_${n}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_filename: `video_${n}.mp4`,
        storage_key: `event-key-${n}`,
      }),
    );
  }

  it('should persist an event with status, attempt and nullable message', async () => {
    const video = await createVideo();

    const event = await eventRepository.save(
      eventRepository.create({
        video_id: video.id,
        status: VideoProcessingEventStatus.READY,
        attempt: 1,
      }),
    );

    expect(event.status).toBe(VideoProcessingEventStatus.READY);
    expect(event.attempt).toBe(1);
    expect(event.message).toBeNull();
  });

  it('should fail with invalid video_id due to FK violation', async () => {
    await expect(
      eventRepository.save(
        eventRepository.create({
          video_id: '00000000-0000-0000-0000-000000000000',
          status: VideoProcessingEventStatus.ERROR,
          attempt: 1,
          message: 'boom',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should load the related video via the ManyToOne relation', async () => {
    const video = await createVideo();
    await eventRepository.save(
      eventRepository.create({
        video_id: video.id,
        status: VideoProcessingEventStatus.ERROR,
        attempt: 3,
        message: 'ffmpeg failed',
      }),
    );

    const found = await eventRepository.findOne({
      where: { video_id: video.id },
      relations: ['video'],
    });

    expect(found?.video.id).toBe(video.id);
    expect(found?.message).toBe('ffmpeg failed');
  });

  it('should allow multiple events for the same video (retry history)', async () => {
    const video = await createVideo();

    await eventRepository.save(
      eventRepository.create({
        video_id: video.id,
        status: VideoProcessingEventStatus.PROCESSING,
        attempt: 1,
      }),
    );
    await eventRepository.save(
      eventRepository.create({
        video_id: video.id,
        status: VideoProcessingEventStatus.ERROR,
        attempt: 1,
        message: 'first attempt failed',
      }),
    );

    const events = await eventRepository.find({
      where: { video_id: video.id },
    });
    expect(events).toHaveLength(2);
  });
});
