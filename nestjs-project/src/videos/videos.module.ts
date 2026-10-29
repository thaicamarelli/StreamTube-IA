import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoProcessingEvent } from './entities/video-processing-event.entity';
import { VideosService } from './videos.service';
import { VideosController } from './videos.controller';
import {
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, VideoProcessingEvent]),
    StorageModule,
    ChannelsModule,
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS,
    }),
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [TypeOrmModule, StorageModule],
})
export class VideosModule {}
