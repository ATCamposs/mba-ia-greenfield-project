import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { VideoProcessor } from './video-processing/video.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with the real config schema and expose the video processor', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor, { strict: false })).toBeDefined();
    await module.close();
  }, 30000);

  it('should keep the processor out of the API so only the worker consumes the queue', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(() => module.get(VideoProcessor, { strict: false })).toThrow();
    await module.close();
  }, 30000);
});
