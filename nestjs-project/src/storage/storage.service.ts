import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface CompletedPart {
  partNumber: number;
  eTag: string;
}

const PART_SIZE_BYTES = 100 * 1024 * 1024; // 100MB per part
const GET_URL_TTL_SECONDS = 900; // 15 minutes, per phase-03-videos/TD-05
// Part-upload URLs must stay valid for the whole upload window, not just a
// single request — a 10GB upload (per TD-03) can take well over an hour on
// typical connections, so this is deliberately much longer than the GET TTL.
const PART_UPLOAD_URL_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Builds a Content-Disposition value per RFC 6266: a quoted-string fallback
// with embedded quotes/backslashes stripped (for older clients) plus a
// filename*=UTF-8'' extended form so non-ASCII titles (e.g. Portuguese
// accents) survive for clients that support it.
function buildAttachmentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/["\\]/g, '');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

@Injectable()
export class StorageService {
  private readonly client: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  get videosBucket(): string {
    return this.config.videosBucket;
  }

  get thumbnailsBucket(): string {
    return this.config.thumbnailsBucket;
  }

  get partSizeBytes(): number {
    return PART_SIZE_BYTES;
  }

  partCountForSize(fileSizeBytes: number): number {
    return Math.max(1, Math.ceil(fileSizeBytes / PART_SIZE_BYTES));
  }

  async createMultipartUpload(bucket: string, key: string): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    );
    if (!result.UploadId) {
      throw new Error('Storage did not return an UploadId');
    }
    return result.UploadId;
  }

  async getPresignedPartUrls(
    bucket: string,
    key: string,
    uploadId: string,
    partCount: number,
  ): Promise<PresignedPart[]> {
    const parts: PresignedPart[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const command = new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      const url = await getSignedUrl(this.client, command, {
        expiresIn: PART_UPLOAD_URL_TTL_SECONDS,
      });
      parts.push({ partNumber, url });
    }
    return parts;
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          // Real S3 requires parts in ascending PartNumber order; MinIO is
          // more lenient, so this must be enforced here rather than relying
          // on caller-supplied order.
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.eTag,
            })),
        },
      }),
    );
  }

  async getPresignedGetUrl(
    bucket: string,
    key: string,
    options: { disposition: 'inline' | 'attachment'; filename?: string },
  ): Promise<string> {
    const contentDisposition =
      options.disposition === 'attachment'
        ? buildAttachmentDisposition(options.filename ?? key)
        : 'inline';

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: contentDisposition,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: GET_URL_TTL_SECONDS,
    });
  }
}
