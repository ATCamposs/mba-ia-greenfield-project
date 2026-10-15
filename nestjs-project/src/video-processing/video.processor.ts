import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import {
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/video-queue.constants';
import { InvalidMediaError } from './probe-result';
import {
  SourceMissingError,
  VideoProcessingService,
} from './video-processing.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly processing: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    try {
      await this.processing.process(videoId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Video ${videoId} attempt failed: ${message}`);

      // Permanent failures skip the retries; other errors fail the video only on the last attempt.
      if (error instanceof InvalidMediaError) {
        await this.processing.markFailed(videoId, 'INVALID_MEDIA');
        throw new UnrecoverableError(message);
      }
      if (error instanceof SourceMissingError) {
        await this.processing.markFailed(videoId, 'SOURCE_MISSING');
        throw new UnrecoverableError(message);
      }
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await this.processing.markFailed(videoId, 'PROCESSING_FAILED');
      }
      throw error;
    }
  }
}
