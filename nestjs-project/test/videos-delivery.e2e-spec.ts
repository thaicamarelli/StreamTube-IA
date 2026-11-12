import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('videos-delivery', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let s3Client: S3Client;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    s3Client = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
      region: process.env.STORAGE_REGION || 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY || 'streamtube',
        secretAccessKey: process.env.STORAGE_SECRET_KEY || 'streamtube123',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createVideo(overrides: Partial<Video> = {}): Promise<Video> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `delivery_${n}@example.com`,
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
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_filename: 'video.mp4',
        storage_key: randomUUID(),
        status: VideoStatus.DRAFT,
        ...overrides,
      }),
    );
  }

  async function putRealObject(storageKey: string): Promise<void> {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_VIDEOS_BUCKET || 'videos',
        Key: storageKey,
        Body: Buffer.from('e2e delivery test content'),
      }),
    );
  }

  describe('1. Video detail read', () => {
    it('1.1 existing-video-returns-200-with-fields', async () => {
      const video = await createVideo({
        title: 'Meu vídeo',
        status: VideoStatus.READY,
        duration_seconds: 42,
      });

      const response = await request(app.getHttpServer()).get(
        `/videos/${video.id}`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: video.id,
        channelId: video.channel_id,
        title: 'Meu vídeo',
        status: 'ready',
        durationSeconds: 42,
        errorReason: null,
      });
      expect(response.body.createdAt).toBeDefined();
    });

    it('1.2 nonexistent-video-returns-video-not-found', async () => {
      const response = await request(app.getHttpServer()).get(
        '/videos/00000000-0000-0000-0000-000000000000',
      );

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('malformed-video-id-returns-bad-request', async () => {
      const response = await request(app.getHttpServer()).get(
        '/videos/not-a-uuid',
      );

      expect(response.status).toBe(400);
    });
  });

  describe('2. Streaming and download delivery', () => {
    it('2.1 ready-video-stream-redirects-with-inline-disposition', async () => {
      const video = await createVideo({ status: VideoStatus.READY });
      await putRealObject(video.storage_key);

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.id}/stream`)
        .redirects(0);

      expect(response.status).toBe(302);
      const location = response.headers.location;
      expect(location).toContain('response-content-disposition=inline');
    });

    it('2.2 non-ready-video-stream-returns-video-not-ready', async () => {
      const video = await createVideo({ status: VideoStatus.PROCESSING });

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.id}/stream`)
        .redirects(0);

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('VIDEO_NOT_READY');
    });

    it('2.3 ready-video-download-redirects-with-attachment-disposition', async () => {
      const video = await createVideo({
        status: VideoStatus.READY,
        original_filename: 'meu-video.mp4',
      });
      await putRealObject(video.storage_key);

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.id}/download`)
        .redirects(0);

      expect(response.status).toBe(302);
      const location = decodeURIComponent(response.headers.location);
      expect(location).toContain('response-content-disposition=attachment');
      expect(location).toContain('filename="meu-video.mp4"');
    });

    it('non-ready-video-download-returns-video-not-ready', async () => {
      const video = await createVideo({ status: VideoStatus.DRAFT });

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.id}/download`)
        .redirects(0);

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('VIDEO_NOT_READY');
    });

    it('nonexistent-video-stream-returns-video-not-found', async () => {
      const response = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/stream')
        .redirects(0);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('nonexistent-video-download-returns-video-not-found', async () => {
      const response = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/download')
        .redirects(0);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('malformed-video-id-returns-bad-request-on-stream', async () => {
      const response = await request(app.getHttpServer())
        .get('/videos/not-a-uuid/stream')
        .redirects(0);

      expect(response.status).toBe(400);
    });

    it('malformed-video-id-returns-bad-request-on-download', async () => {
      const response = await request(app.getHttpServer())
        .get('/videos/not-a-uuid/download')
        .redirects(0);

      expect(response.status).toBe(400);
    });
  });
});
