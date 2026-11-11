import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Video } from '../src/videos/entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESS_JOB_NAME,
} from '../src/videos/videos.constants';
import type { VideoProcessJobData } from '../src/videos/video-processing.consumer';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('videos-complete-upload', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue<VideoProcessJobData>;

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
    videoRepository = dataSource.getRepository(Video);
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  let counter = 0;
  // Real register -> confirm-email -> login HTTP flow, same convention as
  // test/videos-initiate-upload.e2e-spec.ts — proves a token actually issued
  // by /auth/login works end-to-end, not one fabricated by the test.
  async function registerConfirmAndLogin(): Promise<{ accessToken: string }> {
    const email = `e2e_complete_${++counter}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return { accessToken: loginRes.body.access_token };
  }

  async function createDraftWithUploadedPart(
    accessToken: string,
  ): Promise<{ videoId: string; eTag: string }> {
    const initiateRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ originalFilename: 'complete-me.mp4', fileSizeBytes: 1024 });

    const partUrl = initiateRes.body.parts[0].url as string;
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: Buffer.from('e2e test content'),
    });
    const eTag = putResponse.headers.get('etag')!;

    return { videoId: initiateRes.body.id as string, eTag };
  }

  describe('1. Upload completion', () => {
    it('1.1 valid-completion-returns-202-and-sets-processing', async () => {
      const { accessToken } = await registerConfirmAndLogin();
      const { videoId, eTag } = await createDraftWithUploadedPart(accessToken);

      const response = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag }] });

      expect(response.status).toBe(202);

      const video = await videoRepository.findOneBy({ id: videoId });
      expect(video?.status).toBe('processing');

      const jobs = await queue.getJobs(['waiting', 'completed']);
      const matching = jobs.filter(
        (job) =>
          job.name === VIDEO_PROCESS_JOB_NAME && job.data.videoId === videoId,
      );
      expect(matching).toHaveLength(1);
    });

    it('1.2 nonexistent-video-returns-video-not-found', async () => {
      const { accessToken } = await registerConfirmAndLogin();

      const response = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag: '"irrelevant"' }] });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('1.3 non-owner-returns-forbidden', async () => {
      const { accessToken: ownerToken } = await registerConfirmAndLogin();
      const { accessToken: otherToken } = await registerConfirmAndLogin();
      const { videoId, eTag } = await createDraftWithUploadedPart(ownerToken);

      const response = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ partNumber: 1, eTag }] });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('FORBIDDEN_NOT_OWNER');
    });

    it('1.4 already-completed-returns-conflict', async () => {
      const { accessToken } = await registerConfirmAndLogin();
      const { videoId, eTag } = await createDraftWithUploadedPart(accessToken);

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag }] });

      const response = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag }] });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('UPLOAD_ALREADY_COMPLETED');
    });

    it('1.5 missing-access-token-returns-unauthorized', async () => {
      const { accessToken } = await registerConfirmAndLogin();
      const { videoId, eTag } = await createDraftWithUploadedPart(accessToken);

      const response = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .send({ parts: [{ partNumber: 1, eTag }] });

      expect(response.status).toBe(401);
    });

    it('1.6 mismatched-parts-returns-incomplete-multipart-upload', async () => {
      const { accessToken } = await registerConfirmAndLogin();
      const { videoId } = await createDraftWithUploadedPart(accessToken);

      const response = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag: '"not-the-real-etag"' }] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INCOMPLETE_MULTIPART_UPLOAD');
    });

    it('1.7 empty-parts-array-returns-validation-error', async () => {
      const { accessToken } = await registerConfirmAndLogin();
      const { videoId } = await createDraftWithUploadedPart(accessToken);

      const response = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [] });

      expect(response.status).toBe(400);
    });

    it('1.8 malformed-video-id-returns-bad-request', async () => {
      const { accessToken } = await registerConfirmAndLogin();

      const response = await request(app.getHttpServer())
        .post('/videos/not-a-uuid/complete')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag: '"irrelevant"' }] });

      expect(response.status).toBe(400);
    });
  });
});
