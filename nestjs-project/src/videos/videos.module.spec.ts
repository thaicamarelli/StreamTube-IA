import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingEvent } from './entities/video-processing-event.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import storageConfig from '../config/storage.config';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  VideoProcessingEvent,
];

describe('VideosModule', () => {
  it('should compile successfully with the video-processing queue registered', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRoot({
          connection: {
            host: process.env.QUEUE_REDIS_HOST || 'redis',
            port: Number(process.env.QUEUE_REDIS_PORT || 6379),
          },
        }),
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
