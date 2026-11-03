import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoProcessingEvent,
  VideoProcessingEventStatus,
} from './entities/video-processing-event.entity';
import { VideoProcessingConsumer } from './video-processing.consumer';
import {
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESS_JOB_NAME,
} from './videos.constants';
import type { VideoProcessJobData } from './video-processing.consumer';

const execFileAsync = promisify(execFile);

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  VideoProcessingEvent,
];

// Decodes the single pixel of a 1x1-scaled image to raw RGB bytes, so the
// thumbnail test can assert which color segment of the fixture video the
// extracted frame actually came from — not just that *some* thumbnail exists.
function averageColor(imagePath: string): Promise<[number, number, number]> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-i',
      imagePath,
      '-vf',
      'scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-y',
      '-',
    ]);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg scale exited with code ${code}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      resolve([buf[0], buf[1], buf[2]]);
    });
  });
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 300,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('VideoProcessingConsumer (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let eventRepository: Repository<VideoProcessingEvent>;
  let storageService: StorageService;
  let queue: Queue<VideoProcessJobData>;
  let app: INestApplication;
  let fixturesDir: string;
  let realVideoPath: string;

  beforeAll(async () => {
    fixturesDir = await mkdtemp(join(tmpdir(), 'consumer-fixtures-'));
    realVideoPath = join(fixturesDir, 'real.mp4');
    // A tiny real, valid MP4 generated on the fly via ffmpeg's lavfi source
    // — avoids committing a binary fixture to the repo. Two color segments
    // (red 0-2s, blue 2-10s) let the thumbnail test assert the extracted
    // frame actually comes from the 10%-of-duration mark (per
    // phase-03-videos/TD-04), not just that *some* thumbnail was produced.
    await execFileAsync('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x64:d=2:r=5',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x64:d=8:r=5',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0',
      '-pix_fmt',
      'yuv420p',
      '-y',
      realVideoPath,
    ]);

    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    eventRepository = dataSource.getRepository(VideoProcessingEvent);

    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, VideoProcessingEvent]),
        BullModule.forRoot({
          connection: {
            host: process.env.QUEUE_REDIS_HOST || 'redis',
            port: Number(process.env.QUEUE_REDIS_PORT || 6379),
          },
        }),
        BullModule.registerQueue({
          name: VIDEO_PROCESSING_QUEUE,
          defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS,
        }),
      ],
      providers: [VideoProcessingConsumer, StorageService],
    }).compile();

    // @nestjs/bullmq's WorkerHost creates the real BullMQ Worker in
    // onModuleInit, which only fires once the app is actually initialized —
    // compile() alone (as used by videos.module.spec.ts for a DI-only check)
    // is not enough here, since this test needs jobs to actually be consumed.
    app = moduleFixture.createNestApplication();
    await app.init();

    storageService = app.get(StorageService);
    queue = app.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 30000);

  afterAll(async () => {
    await app.close();
    await dataSource.destroy();
    await rm(fixturesDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  let counter = 0;
  async function createDraftVideo(): Promise<{ channelId: string }> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `consumer_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `chan_${n}`,
        nickname: `chan_${n}`,
        user_id: user.id,
      }),
    );
    return { channelId: channel.id };
  }

  async function insertProcessingVideo(
    storageKeySource: 'real' | 'corrupted',
  ): Promise<Video> {
    const { channelId } = await createDraftVideo();
    const storageKey = randomUUID();

    if (storageKeySource === 'real') {
      await storageService.uploadObject(
        storageService.videosBucket,
        storageKey,
        realVideoPath,
        'video/mp4',
      );
    } else {
      const corruptedPath = join(fixturesDir, `corrupted-${storageKey}`);
      await writeFile(corruptedPath, Buffer.from('not a real video file'));
      await storageService.uploadObject(
        storageService.videosBucket,
        storageKey,
        corruptedPath,
        'application/octet-stream',
      );
    }

    return videoRepository.save(
      videoRepository.create({
        channel_id: channelId,
        original_filename: 'video.mp4',
        storage_key: storageKey,
        status: VideoStatus.PROCESSING,
        upload_id: 'irrelevant-for-this-test',
      }),
    );
  }

  it('processes a real video end-to-end: ready, duration, thumbnail, single event', async () => {
    const video = await insertProcessingVideo('real');

    await queue.add(VIDEO_PROCESS_JOB_NAME, { videoId: video.id });

    await waitUntil(async () => {
      const current = await videoRepository.findOneBy({ id: video.id });
      return current?.status !== VideoStatus.PROCESSING;
    }, 20000);

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted?.status).toBe(VideoStatus.READY);
    expect(persisted?.duration_seconds).toBe(10);
    expect(persisted?.thumbnail_key).toBe(video.id);

    const events = await eventRepository.find({
      where: { video_id: video.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe(VideoProcessingEventStatus.READY);
    expect(events[0].attempt).toBe(1);

    const thumbnailDest = join(fixturesDir, 'downloaded-thumbnail.jpg');
    await storageService.downloadObject(
      storageService.thumbnailsBucket,
      video.id,
      thumbnailDest,
    );
    const { size } = await stat(thumbnailDest);
    expect(size).toBeGreaterThan(0);

    // 10% of a 10s video is the 1s mark, which falls inside the red
    // segment (0-2s) — a thumbnail taken at the wrong frame (e.g. seek 0,
    // or the end of the file) would come back blue instead.
    const [r, , b] = await averageColor(thumbnailDest);
    expect(r).toBeGreaterThan(150);
    expect(b).toBeLessThan(100);
  }, 30000);

  it('exhausts retries on a corrupted file and ends in error with one event per attempt', async () => {
    const video = await insertProcessingVideo('corrupted');

    await queue.add(VIDEO_PROCESS_JOB_NAME, { videoId: video.id });

    await waitUntil(async () => {
      const current = await videoRepository.findOneBy({ id: video.id });
      return current?.status === VideoStatus.ERROR;
    }, 30000);

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted?.status).toBe(VideoStatus.ERROR);
    expect(persisted?.error_reason).toBeTruthy();
    // error_reason is public (served unauthenticated via GET /videos/:id,
    // per SI-03.8) — it must never contain ffmpeg's raw stderr or the
    // worker's internal temp file paths. The detailed message belongs only
    // on VideoProcessingEvent, which no API exposes.
    expect(persisted?.error_reason).not.toMatch(/ffprobe|tmp|\//);

    const events = await eventRepository.find({
      where: { video_id: video.id },
      order: { attempt: 'ASC' },
    });
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.attempt)).toEqual([1, 2, 3]);
    for (const event of events) {
      expect(event.status).toBe(VideoProcessingEventStatus.ERROR);
      expect(event.message).toBeTruthy();
    }
  }, 40000);
});
