import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;
  let rawClient: S3Client;

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

  it('completes a real multipart upload round-trip against MinIO', async () => {
    const key = `test-object-${Date.now()}`;
    const bucket = service.videosBucket;
    const content = Buffer.from('hello streamtube multipart upload');

    const uploadId = await service.createMultipartUpload(bucket, key);
    expect(uploadId).toBeTruthy();

    const [part] = await service.getPresignedPartUrls(
      bucket,
      key,
      uploadId,
      1,
    );
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

  it('throws when completing with a mismatched part list', async () => {
    const key = `test-object-invalid-${Date.now()}`;
    const bucket = service.videosBucket;

    const uploadId = await service.createMultipartUpload(bucket, key);

    await expect(
      service.completeMultipartUpload(bucket, key, uploadId, [
        { partNumber: 1, eTag: '"not-a-real-etag"' },
      ]),
    ).rejects.toThrow();
  });

  it('getPresignedGetUrl returns a URL that is actually downloadable from MinIO', async () => {
    const key = `test-object-get-${Date.now()}`;
    const bucket = service.videosBucket;
    const content = Buffer.from('downloadable content');

    const uploadId = await service.createMultipartUpload(bucket, key);
    const [part] = await service.getPresignedPartUrls(
      bucket,
      key,
      uploadId,
      1,
    );
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
});
