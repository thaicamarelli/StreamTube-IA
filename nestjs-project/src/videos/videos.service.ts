import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
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
} from './exceptions/video.exceptions';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESS_JOB_NAME,
} from './videos.constants';
import type { VideoProcessJobData } from './video-processing.consumer';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB, per phase-03-videos/TD-03

export interface InitiateUploadResult {
  id: string;
  uploadId: string;
  parts: { partNumber: number; url: string }[];
  partSizeBytes: number;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue<VideoProcessJobData>,
  ) {}

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
      await this.storageService.abortMultipartUpload(bucket, videoId, uploadId);
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
      await this.storageService.abortMultipartUpload(bucket, videoId, uploadId);
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
    } catch {
      throw new IncompleteMultipartUploadException();
    }

    // Enqueued before the status update: BullMQ persists the job in Redis
    // durably once add() resolves, so a failure here leaves the video in
    // draft with nothing enqueued — a safe, visible state. Doing it in the
    // opposite order would risk a video stuck in "processing" forever with
    // no job tracking it, if the DB write succeeded but the enqueue failed.
    await this.videoProcessingQueue.add(VIDEO_PROCESS_JOB_NAME, { videoId });

    await this.videoRepository.update(videoId, {
      status: VideoStatus.PROCESSING,
    });
  }
}
