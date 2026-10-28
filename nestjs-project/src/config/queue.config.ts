import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.QUEUE_REDIS_HOST || 'redis',
  port: parseInt(process.env.QUEUE_REDIS_PORT || '6379', 10),
}));
