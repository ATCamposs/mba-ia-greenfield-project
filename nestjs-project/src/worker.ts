import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM closes the BullMQ worker so an in-flight job is not left locked.
  app.enableShutdownHooks();
  new Logger('VideoWorker').log('Video worker is consuming video-processing');
}
void bootstrap();
