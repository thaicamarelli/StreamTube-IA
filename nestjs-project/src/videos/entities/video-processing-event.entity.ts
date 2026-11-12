import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Video } from './video.entity';

export enum VideoProcessingEventStatus {
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

@Entity('video_processing_events')
export class VideoProcessingEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  video_id: string;

  @Column({
    type: 'enum',
    enum: VideoProcessingEventStatus,
  })
  status: VideoProcessingEventStatus;

  @Column({ type: 'int' })
  attempt: number;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => Video, (video) => video.processingEvents)
  @JoinColumn({ name: 'video_id' })
  video: Video;
}
