import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker/worker.module';

const logger = new Logger('Worker');

async function bootstrap() {
  await NestFactory.createApplicationContext(WorkerModule);
  logger.log('Video processing worker started');
}
void bootstrap();
