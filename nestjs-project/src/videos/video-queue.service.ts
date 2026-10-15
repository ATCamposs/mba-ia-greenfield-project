import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-queue.constants';

@Injectable()
export class VideoQueueService {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  // The jobId deduplicates: enqueueing the same video again is a no-op while the job exists.
  async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { jobId: `video-${videoId}` },
    );
  }
}
