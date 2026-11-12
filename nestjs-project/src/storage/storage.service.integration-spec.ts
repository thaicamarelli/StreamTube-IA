import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;
  let rawClient: S3Client;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();

    service = module.get(StorageService);

    rawClient = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
      region: process.env.STORAGE_REGION || 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY || 'streamtube',
        secretAccessKey: process.env.STORAGE_SECRET_KEY || 'streamtube123',
      },
    });
  });

  afterAll(async () => {
    const bucket = service.videosBucket;
    await Promise.all(
      createdKeys.map((key) =>
        rawClient
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
          .catch(() => undefined),
      ),
    );
  });

  function trackKey(key: string): string {
    createdKeys.push(key);
    return key;
  }

  it('completes a real multipart upload round-trip against MinIO', async () => {
    const key = trackKey(`test-object-${Date.now()}`);
    const bucket = service.videosBucket;
    const content = Buffer.from('hello streamtube multipart upload');

    const uploadId = await service.createMultipartUpload(bucket, key);
    expect(uploadId).toBeTruthy();

    const [part] = await service.getPresignedPartUrls(bucket, key, uploadId, 1);
    expect(part.url).toContain('X-Amz-Signature');

    const putResponse = await fetch(part.url, {
      method: 'PUT',
      body: content,
    });
    expect(putResponse.status).toBe(200);
    const eTag = putResponse.headers.get('etag');
    expect(eTag).toBeTruthy();

    await service.completeMultipartUpload(bucket, key, uploadId, [
      { partNumber: 1, eTag: eTag! },
    ]);

    const getResult = await rawClient.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = await getResult.Body?.transformToString();
    expect(body).toBe(content.toString());
  });

  it('completes a multi-part upload and tolerates parts submitted out of order', async () => {
    const key = trackKey(`test-object-multipart-${Date.now()}`);
    const bucket = service.videosBucket;
    // Real S3 (and MinIO) require every part except the last to be >= 5MB.
    const partA = Buffer.alloc(5 * 1024 * 1024, 'a');
    const partB = Buffer.from('final smaller part');

    const uploadId = await service.createMultipartUpload(bucket, key);
    const parts = await service.getPresignedPartUrls(bucket, key, uploadId, 2);
    expect(parts).toHaveLength(2);

    const putA = await fetch(parts[0].url, { method: 'PUT', body: partA });
    const putB = await fetch(parts[1].url, { method: 'PUT', body: partB });
    expect(putA.status).toBe(200);
    expect(putB.status).toBe(200);

    // Submit deliberately out of order (part 2 before part 1) — the service
    // must sort by partNumber before calling CompleteMultipartUpload.
    await service.completeMultipartUpload(bucket, key, uploadId, [
      { partNumber: 2, eTag: putB.headers.get('etag')! },
      { partNumber: 1, eTag: putA.headers.get('etag')! },
    ]);

    const getResult = await rawClient.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = await getResult.Body?.transformToByteArray();
    expect(Buffer.from(body!).length).toBe(partA.length + partB.length);
  });

  it('throws an identifiable storage error when completing with a mismatched part list', async () => {
    const key = trackKey(`test-object-invalid-${Date.now()}`);
    const bucket = service.videosBucket;

    const uploadId = await service.createMultipartUpload(bucket, key);

    let caught: unknown;
    try {
      await service.completeMultipartUpload(bucket, key, uploadId, [
        { partNumber: 1, eTag: '"not-a-real-etag"' },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBeTruthy();
  });

  it('throws when completing with a part number that was never uploaded', async () => {
    const key = trackKey(`test-object-incomplete-${Date.now()}`);
    const bucket = service.videosBucket;
    const content = Buffer.from('only one part was actually uploaded');

    const uploadId = await service.createMultipartUpload(bucket, key);
    // Only part 1 is ever presigned and uploaded.
    const [part] = await service.getPresignedPartUrls(bucket, key, uploadId, 1);
    const putResponse = await fetch(part.url, { method: 'PUT', body: content });
    const eTag = putResponse.headers.get('etag')!;

    // Reference part 2, which was never created for this upload — storage
    // has nothing to match it against and must reject the request. (Note:
    // CompleteMultipartUpload only assembles the parts *listed* in the
    // request — submitting a subset of the uploaded parts is valid S3
    // behavior, not an error, so that scenario is intentionally not tested
    // here as a failure case.)
    await expect(
      service.completeMultipartUpload(bucket, key, uploadId, [
        { partNumber: 1, eTag },
        { partNumber: 2, eTag: '"never-uploaded"' },
      ]),
    ).rejects.toThrow();
  });

  it('abortMultipartUpload actually cancels the upload in MinIO', async () => {
    const key = trackKey(`test-object-abort-${Date.now()}`);
    const bucket = service.videosBucket;

    const uploadId = await service.createMultipartUpload(bucket, key);
    const [part] = await service.getPresignedPartUrls(bucket, key, uploadId, 1);
    const putResponse = await fetch(part.url, {
      method: 'PUT',
      body: Buffer.from('part that will never be completed'),
    });
    const eTag = putResponse.headers.get('etag')!;

    await service.abortMultipartUpload(bucket, key, uploadId);

    // The upload no longer exists in storage, so completing it must fail.
    await expect(
      service.completeMultipartUpload(bucket, key, uploadId, [
        { partNumber: 1, eTag },
      ]),
    ).rejects.toThrow();
  });

  it('getPresignedGetUrl returns a URL that is actually downloadable from MinIO', async () => {
    const key = trackKey(`test-object-get-${Date.now()}`);
    const bucket = service.videosBucket;
    const content = Buffer.from('downloadable content');

    const uploadId = await service.createMultipartUpload(bucket, key);
    const [part] = await service.getPresignedPartUrls(bucket, key, uploadId, 1);
    const putResponse = await fetch(part.url, {
      method: 'PUT',
      body: content,
    });
    const eTag = putResponse.headers.get('etag')!;
    await service.completeMultipartUpload(bucket, key, uploadId, [
      { partNumber: 1, eTag },
    ]);

    const getUrl = await service.getPresignedGetUrl(bucket, key, {
      disposition: 'inline',
    });
    const downloadResponse = await fetch(getUrl);
    expect(downloadResponse.status).toBe(200);
    expect(await downloadResponse.text()).toBe(content.toString());
  });

  describe('uploadObject / downloadObject', () => {
    let tempDir: string;

    beforeAll(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'storage-service-'));
    });

    afterAll(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('round-trips a file through a real single-shot PUT/GET against MinIO', async () => {
      const key = trackKey(`test-object-upload-${Date.now()}`);
      const bucket = service.videosBucket;
      const sourcePath = join(tempDir, 'source.txt');
      const destPath = join(tempDir, 'downloaded.txt');
      const content = 'content written via uploadObject/downloadObject';
      await writeFile(sourcePath, content);

      await service.uploadObject(bucket, key, sourcePath, 'text/plain');
      await service.downloadObject(bucket, key, destPath);

      const downloaded = await readFile(destPath, 'utf-8');
      expect(downloaded).toBe(content);
    });

    it('downloadObject rejects when the key does not exist', async () => {
      const bucket = service.videosBucket;
      const destPath = join(tempDir, 'never-written.txt');

      await expect(
        service.downloadObject(bucket, 'does-not-exist', destPath),
      ).rejects.toThrow();
    });
  });
});
