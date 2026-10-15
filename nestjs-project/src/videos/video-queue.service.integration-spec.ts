import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-queue.constants';
import { VideoQueueModule } from './video-queue.module';
import { VideoQueueService } from './video-queue.service';

describe('VideoQueueService (integration, real Redis)', () => {
  let module: TestingModule;
  let service: VideoQueueService;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        VideoQueueModule,
      ],
    }).compile();
    await module.init();
    service = module.get(VideoQueueService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE), {
      strict: false,
    });
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('should add one job carrying the video id, deterministic job id and retry policy', async () => {
    const videoId = randomUUID();

    await service.enqueueProcessing(videoId);

    const job = await queue.getJob(`video-${videoId}`);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('should keep a single job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await service.enqueueProcessing(videoId);
    await service.enqueueProcessing(videoId);

    const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
    expect(counts.waiting + counts.delayed + counts.active).toBe(1);
  });
});
