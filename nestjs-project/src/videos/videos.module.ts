import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoProcessingEvent } from './entities/video-processing-event.entity';
import {
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, VideoProcessingEvent]),
    StorageModule,
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS,
    }),
  ],
  exports: [TypeOrmModule, StorageModule, BullModule],
})
export class VideosModule {}
