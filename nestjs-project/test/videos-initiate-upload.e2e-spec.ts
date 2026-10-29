import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { Video } from '../src/videos/entities/video.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('videos-initiate-upload', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

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
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  // Exercises the real register -> confirm-email -> login HTTP flow so these
  // tests prove a token actually issued by /auth/login, for a channel
  // actually created by ChannelsService.createChannel, works against
  // POST /videos — not a token/channel fabricated by the test itself.
  async function registerConfirmAndLogin(): Promise<{
    accessToken: string;
    channelId: string;
  }> {
    const email = `e2e_upload_${++counter}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });

    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    const channel = await channelRepository.findOneBy({
      user_id: registerRes.body.id,
    });

    return {
      accessToken: loginRes.body.access_token,
      channelId: channel!.id,
    };
  }

  describe('1. Upload initiation', () => {
    it('1.1 valid-upload-request-returns-draft-and-presigned-parts', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ originalFilename: 'video.mp4', fileSizeBytes: 52428800 });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.uploadId).toBeDefined();
      expect(Array.isArray(response.body.parts)).toBe(true);
      expect(response.body.parts.length).toBeGreaterThan(0);
      expect(response.body.partSizeBytes).toBeDefined();

      const video = await videoRepository.findOneBy({ id: response.body.id });
      expect(video?.status).toBe('draft');
      expect(video?.original_filename).toBe('video.mp4');
      expect(video?.channel_id).toBe(channelId);
    });

    it('1.2 file-size-above-10gb-returns-file-too-large', async () => {
      const { accessToken } = await registerConfirmAndLogin();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          originalFilename: 'huge.mp4',
          fileSizeBytes: 10737418241,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('FILE_TOO_LARGE');
    });

    it('1.3 missing-access-token-returns-unauthorized', async () => {
      const response = await request(app.getHttpServer())
        .post('/videos')
        .send({ originalFilename: 'video.mp4', fileSizeBytes: 52428800 });

      expect(response.status).toBe(401);
    });

    it('1.4 original-filename-above-255-chars-returns-bad-request', async () => {
      const { accessToken } = await registerConfirmAndLogin();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          originalFilename: 'a'.repeat(256) + '.mp4',
          fileSizeBytes: 52428800,
        });

      expect(response.status).toBe(400);
    });
  });
});
