import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import queueConfig from '../config/queue.config';
import { envValidationSchema } from '../config/env.validation';
import { VideoProcessingConsumer } from '../videos/video-processing.consumer';
import {
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/videos.constants';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.host, port: config.port },
      }),
    }),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS,
    }),
  ],
  providers: [VideoProcessingConsumer],
})
export class WorkerModule {}
