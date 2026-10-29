import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker/worker.module';

const logger = new Logger('Worker');

export async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  logger.log('Video processing worker started');
  return app;
}

if (require.main === module) {
  bootstrap().catch((error) => {
    logger.error('Video processing worker failed to start', error);
    process.exit(1);
  });
}
