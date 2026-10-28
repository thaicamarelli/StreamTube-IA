import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoProcessingEvent } from './entities/video-processing-event.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, VideoProcessingEvent]),
    StorageModule,
  ],
  exports: [TypeOrmModule, StorageModule],
})
export class VideosModule {}
