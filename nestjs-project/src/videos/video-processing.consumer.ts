import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';

export interface VideoProcessJobData {
  videoId: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingConsumer extends WorkerHost {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async process(job: Job<VideoProcessJobData>): Promise<void> {
    // Metadata extraction, thumbnail generation, and status transitions are
    // implemented in SI-03.9 — this SI only wires the queue/worker scaffold.
  }
}
