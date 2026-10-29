import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { User } from '../src/users/entities/user.entity';
import { Channel } from '../src/channels/entities/channel.entity';
import { Video } from '../src/videos/entities/video.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('videos-initiate-upload', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let jwtService: JwtService;

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
    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createAuthenticatedUser(): Promise<{
    accessToken: string;
    channelId: string;
  }> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `e2e_upload_${n}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `chan_${n}`,
        nickname: `chan_${n}`,
        user_id: user.id,
      }),
    );
    const accessToken = jwtService.sign({ sub: user.id, email: user.email });
    return { accessToken, channelId: channel.id };
  }

  describe('1. Upload initiation', () => {
    it('1.1 valid-upload-request-returns-draft-and-presigned-parts', async () => {
      const { accessToken, channelId } = await createAuthenticatedUser();

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
      const { accessToken } = await createAuthenticatedUser();

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
  });
});
