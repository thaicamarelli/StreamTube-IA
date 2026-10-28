import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService', () => {
  let service: StorageService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();

    service = module.get(StorageService);
  });

  it('exposes the configured bucket names', () => {
    expect(service.videosBucket).toBe('videos');
    expect(service.thumbnailsBucket).toBe('thumbnails');
  });

  it('computes part count based on the configured part size', () => {
    expect(service.partCountForSize(1)).toBe(1);
    expect(service.partCountForSize(service.partSizeBytes)).toBe(1);
    expect(service.partCountForSize(service.partSizeBytes + 1)).toBe(2);
    expect(service.partCountForSize(service.partSizeBytes * 3)).toBe(3);
  });

  it('getPresignedGetUrl builds an inline disposition URL with a 15-minute TTL', async () => {
    const url = await service.getPresignedGetUrl('videos', 'some-key', {
      disposition: 'inline',
    });
    const parsed = new URL(url);

    expect(parsed.searchParams.get('response-content-disposition')).toBe(
      'inline',
    );
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
  });

  it('getPresignedGetUrl builds an attachment disposition URL with the given filename', async () => {
    const url = await service.getPresignedGetUrl('videos', 'some-key', {
      disposition: 'attachment',
      filename: 'meu-video.mp4',
    });
    const parsed = new URL(url);

    expect(parsed.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="meu-video.mp4"; filename*=UTF-8\'\'meu-video.mp4',
    );
  });

  it('getPresignedGetUrl strips unsafe characters from the ASCII filename fallback', async () => {
    const url = await service.getPresignedGetUrl('videos', 'some-key', {
      disposition: 'attachment',
      filename: 'ví"deo\\especial.mp4',
    });
    const parsed = new URL(url);
    const disposition = parsed.searchParams.get(
      'response-content-disposition',
    )!;

    expect(disposition).not.toContain('\\');
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent('ví"deo\\especial.mp4')}`,
    );
  });

  it('getPresignedPartUrls signs part-upload URLs with a 24h TTL (longer than the GET TTL)', async () => {
    const [part] = await service.getPresignedPartUrls(
      'videos',
      'some-key',
      'fake-upload-id',
      1,
    );
    const parsed = new URL(part.url);

    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('86400');
  });
});
