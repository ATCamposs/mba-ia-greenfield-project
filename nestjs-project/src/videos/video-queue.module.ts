import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { VIDEO_PROCESSING_QUEUE } from './video-queue.constants';
import { VideoQueueService } from './video-queue.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 24 * 3600 },
        removeOnFail: false,
      },
    }),
  ],
  providers: [VideoQueueService],
  exports: [VideoQueueService],
})
export class VideoQueueModule {}
