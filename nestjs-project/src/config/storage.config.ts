import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY || 'streamtube',
  secretAccessKey: process.env.STORAGE_SECRET_KEY || 'streamtube123',
  forcePathStyle: true,
  videosBucket: process.env.STORAGE_VIDEOS_BUCKET || 'videos',
  thumbnailsBucket: process.env.STORAGE_THUMBNAILS_BUCKET || 'thumbnails',
}));
