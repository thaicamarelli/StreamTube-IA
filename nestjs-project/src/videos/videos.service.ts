import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import {
  ChannelNotFoundException,
  FileTooLargeException,
  ForbiddenNotOwnerException,
  IncompleteMultipartUploadException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESS_JOB_NAME,
} from './videos.constants';
import type { VideoProcessJobData } from './video-processing.consumer';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB, per phase-03-videos/TD-03

// S3/MinIO error codes that specifically mean "the submitted parts list
// doesn't match what storage expects" — the only case the Error Catalog's
// 400 INCOMPLETE_MULTIPART_UPLOAD is meant to cover. Any other error
// (network, auth, MinIO unavailable) must propagate as-is rather than being
// masked as a client-input problem.
const MULTIPART_MISMATCH_ERROR_NAMES = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'NoSuchUpload',
  'EntityTooSmall',
]);

function isMultipartMismatchError(error: unknown): boolean {
  return (
    error instanceof Error && MULTIPART_MISMATCH_ERROR_NAMES.has(error.name)
  );
}

export interface InitiateUploadResult {
  id: string;
  uploadId: string;
  parts: { partNumber: number; url: string }[];
  partSizeBytes: number;
}

export interface VideoDetailResult {
  id: string;
  channelId: string;
  title: string | null;
  status: VideoStatus;
  durationSeconds: number | null;
  errorReason: string | null;
  createdAt: Date;
}

export type DeliveryDisposition = 'inline' | 'attachment';

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue<VideoProcessJobData>,
  ) {}

  // Best-effort compensation: if the abort itself fails (e.g. storage also
  // unreachable), that secondary failure must not replace the original error
  // the caller is already propagating — log it and move on.
  private async tryAbortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(bucket, key, uploadId);
    } catch (abortError) {
      this.logger.warn(
        `Failed to abort multipart upload ${uploadId} for ${bucket}/${key}: ${
          abortError instanceof Error ? abortError.message : String(abortError)
        }`,
      );
    }
  }

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    if (dto.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new FileTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    // The video's own UUID doubles as the storage key (per
    // phase-03-videos/TD-02), so it is generated here rather than left to
    // the DB default — storage orchestration needs the id before the row
    // is fully persisted.
    const videoId = randomUUID();
    const bucket = this.storageService.videosBucket;

    // Storage is orchestrated before any DB write: if nothing has been
    // persisted yet, a failure here needs no compensation. Once the
    // multipart upload exists in storage, every subsequent failure path
    // aborts it instead of leaving an orphaned upload with no tracking row.
    const uploadId = await this.storageService.createMultipartUpload(
      bucket,
      videoId,
    );

    let parts: { partNumber: number; url: string }[];
    try {
      const partCount = this.storageService.partCountForSize(dto.fileSizeBytes);
      parts = await this.storageService.getPresignedPartUrls(
        bucket,
        videoId,
        uploadId,
        partCount,
      );
    } catch (error) {
      await this.tryAbortMultipartUpload(bucket, videoId, uploadId);
      throw error;
    }

    try {
      const video = this.videoRepository.create({
        id: videoId,
        channel_id: channel.id,
        original_filename: dto.originalFilename,
        storage_key: videoId,
        upload_id: uploadId,
      });
      await this.videoRepository.save(video);
    } catch (error) {
      await this.tryAbortMultipartUpload(bucket, videoId, uploadId);
      throw error;
    }

    return {
      id: videoId,
      uploadId,
      parts,
      partSizeBytes: this.storageService.partSizeBytes,
    };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteVideoUploadDto,
  ): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channel_id) {
      throw new ForbiddenNotOwnerException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new UploadAlreadyCompletedException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        this.storageService.videosBucket,
        video.storage_key,
        // Set on every draft row by initiateUpload — never null while
        // status is still draft.
        video.upload_id as string,
        dto.parts,
      );
    } catch (error) {
      // Only a genuine parts mismatch is the client's fault (400). Anything
      // else (MinIO unreachable, auth failure, timeout) is an infra problem
      // and must not be masked as "your parts list is wrong" — propagate it
      // as-is so it surfaces as a 500, not a misleading client error.
      if (isMultipartMismatchError(error)) {
        throw new IncompleteMultipartUploadException();
      }
      throw error;
    }

    // Status is set to processing *before* enqueueing: the worker could, in
    // principle, dequeue and finish the job (setting status: ready) faster
    // than this method's own subsequent write — enqueueing first would let
    // that write silently clobber the worker's "ready" back to "processing".
    // Setting status first closes that window; if the enqueue itself then
    // fails, the status is reverted back to draft so the video isn't left
    // stuck in "processing" with nothing tracking it.
    await this.videoRepository.update(videoId, {
      status: VideoStatus.PROCESSING,
    });

    try {
      await this.videoProcessingQueue.add(VIDEO_PROCESS_JOB_NAME, {
        videoId,
      });
    } catch (error) {
      await this.videoRepository.update(videoId, {
        status: VideoStatus.DRAFT,
      });
      throw error;
    }
  }

  async getVideoDetail(videoId: string): Promise<VideoDetailResult> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    return {
      id: video.id,
      channelId: video.channel_id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      errorReason: video.error_reason,
      createdAt: video.created_at,
    };
  }

  async getDeliveryUrl(
    videoId: string,
    disposition: DeliveryDisposition,
  ): Promise<string> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    return this.storageService.getPresignedGetUrl(
      this.storageService.videosBucket,
      video.storage_key,
      {
        disposition,
        filename:
          disposition === 'attachment' ? video.original_filename : undefined,
      },
    );
  }
}
