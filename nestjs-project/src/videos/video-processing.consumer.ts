import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoProcessingEvent,
  VideoProcessingEventStatus,
} from './entities/video-processing-event.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { extractDurationSeconds, generateThumbnail } from './ffmpeg.util';

export interface VideoProcessJobData {
  videoId: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingConsumer extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(VideoProcessingEvent)
    private readonly eventRepository: Repository<VideoProcessingEvent>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    const { videoId } = job.data;
    // job.attemptsMade counts attempts already *completed* (0 on the first
    // call), so the current attempt number is one more than that.
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new Error(`Video ${videoId} not found`);
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'video-processing-'));
    const sourcePath = join(tempDir, 'source');
    const thumbnailPath = join(tempDir, 'thumbnail.jpg');

    try {
      await this.storageService.downloadObject(
        this.storageService.videosBucket,
        video.storage_key,
        sourcePath,
      );

      const durationSeconds = await extractDurationSeconds(sourcePath);
      await generateThumbnail(sourcePath, thumbnailPath, durationSeconds * 0.1);
      await this.storageService.uploadObject(
        this.storageService.thumbnailsBucket,
        video.id,
        thumbnailPath,
        'image/jpeg',
      );

      await this.videoRepository.update(video.id, {
        status: VideoStatus.READY,
        duration_seconds: durationSeconds,
        thumbnail_key: video.id,
      });
      await this.eventRepository.save(
        this.eventRepository.create({
          video_id: video.id,
          status: VideoProcessingEventStatus.READY,
          attempt,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.eventRepository.save(
        this.eventRepository.create({
          video_id: video.id,
          status: VideoProcessingEventStatus.ERROR,
          attempt,
          message,
        }),
      );

      // Only the attempt that exhausts the queue's configured retries moves
      // the video to its terminal error state (per phase-03-videos/TD-06) —
      // earlier failures just leave it in "processing" so BullMQ's own
      // backoff can retry naturally.
      if (attempt >= maxAttempts) {
        // error_reason is public (served unauthenticated via GET
        // /videos/:id, per SI-03.8) — the raw message can contain ffmpeg's
        // stderr and the worker's internal temp file paths, so only a
        // generic reason goes here. The detailed message stays on the
        // VideoProcessingEvent row above, which is not exposed by any API.
        await this.videoRepository.update(video.id, {
          status: VideoStatus.ERROR,
          error_reason: 'Video processing failed',
        });
      }

      throw error;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
