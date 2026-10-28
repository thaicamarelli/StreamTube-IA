import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { VideoProcessingEvent } from './entities/video-processing-event.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Video, VideoProcessingEvent])],
  exports: [TypeOrmModule],
})
export class VideosModule {}
