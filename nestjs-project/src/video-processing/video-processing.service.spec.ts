import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { FfmpegError, FfmpegService } from './ffmpeg.service';
import { InvalidMediaError } from './probe-result';
import {
  SourceMissingError,
  VideoProcessingService,
} from './video-processing.service';
import { VideoProcessor } from './video.processor';

const config = {
  maxSizeBytes: 0,
  partSizeBytes: 0,
  uploadUrlTtlSeconds: 0,
  playbackUrlTtlSeconds: 3600,
};

const processingVideo = {
  id: 'video-1',
  status: VideoStatus.Processing,
  source_key: 'videos/video-1/source',
} as Video;

const probed = {
  durationSeconds: 30,
  metadata: {
    format: 'mp4',
    bit_rate: 1,
    video: { codec: 'h264', width: 1, height: 1, frame_rate: 25 },
    audio: null,
  },
};

describe('VideoProcessingService (unit)', () => {
  let repository: { findOne: jest.Mock; update: jest.Mock };
  let storage: {
    headObjectSize: jest.Mock;
    presignGetInternal: jest.Mock;
    putObject: jest.Mock;
  };
  let ffmpeg: { probe: jest.Mock; extractThumbnail: jest.Mock };
  let service: VideoProcessingService;
  let thumbnailPath: string;

  beforeEach(() => {
    repository = {
      findOne: jest.fn().mockResolvedValue(processingVideo),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storage = {
      headObjectSize: jest.fn().mockResolvedValue(1000),
      presignGetInternal: jest.fn().mockResolvedValue('http://minio/source'),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    ffmpeg = {
      probe: jest.fn().mockResolvedValue(probed),
      extractThumbnail: jest
        .fn()
        .mockImplementation(async (_url: string, _at: number, out: string) => {
          thumbnailPath = out;
          await writeFile(out, Buffer.from([0xff, 0xd8, 0xff]));
        }),
    };
    service = new VideoProcessingService(
      repository as unknown as Repository<Video>,
      storage as unknown as StorageService,
      ffmpeg as unknown as FfmpegService,
      config,
    );
  });

  it.each([
    ['is missing', null],
    ['is a draft', { ...processingVideo, status: VideoStatus.Draft }],
    ['is ready', { ...processingVideo, status: VideoStatus.Ready }],
    ['is failed', { ...processingVideo, status: VideoStatus.Failed }],
  ])('does nothing when the video %s', async (_label, video) => {
    repository.findOne.mockResolvedValue(video);

    await service.process('video-1');

    expect(storage.headObjectSize).not.toHaveBeenCalled();
    expect(ffmpeg.probe).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('stores the thumbnail and moves the video to ready with a guarded update', async () => {
    await service.process('video-1');

    expect(ffmpeg.probe).toHaveBeenCalledWith('http://minio/source');
    expect(ffmpeg.extractThumbnail).toHaveBeenCalledWith(
      'http://minio/source',
      3,
      expect.stringContaining('thumbnail-video-1.jpg'),
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(repository.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.Processing },
      {
        status: VideoStatus.Ready,
        duration_seconds: 30,
        metadata: probed.metadata,
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
      },
    );
    expect(existsSync(thumbnailPath)).toBe(false);
  });

  it('removes the temporary thumbnail even when the upload fails', async () => {
    storage.putObject.mockRejectedValue(new Error('storage down'));

    await expect(service.process('video-1')).rejects.toThrow('storage down');

    expect(existsSync(thumbnailPath)).toBe(false);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('fails with SourceMissingError when the source object does not exist', async () => {
    storage.headObjectSize.mockResolvedValue(null);

    await expect(service.process('video-1')).rejects.toBeInstanceOf(
      SourceMissingError,
    );
  });

  it('marks a failure only while the video is still processing', async () => {
    await service.markFailed('video-1', 'INVALID_MEDIA');

    expect(repository.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.Processing },
      { status: VideoStatus.Failed, failure_reason: 'INVALID_MEDIA' },
    );
  });
});

describe('VideoProcessor (unit)', () => {
  let processing: { process: jest.Mock; markFailed: jest.Mock };
  let processor: VideoProcessor;

  const job = (attemptsMade: number, attempts = 3) =>
    ({
      data: { videoId: 'video-1' },
      attemptsMade,
      opts: { attempts },
    }) as unknown as Job<{ videoId: string }>;

  beforeEach(() => {
    processing = {
      process: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    processor = new VideoProcessor(
      processing as unknown as VideoProcessingService,
    );
  });

  it('completes without marking anything on success', async () => {
    await processor.process(job(0));

    expect(processing.process).toHaveBeenCalledWith('video-1');
    expect(processing.markFailed).not.toHaveBeenCalled();
  });

  it('marks invalid media failed on the first attempt and stops the retries', async () => {
    processing.process.mockRejectedValue(new InvalidMediaError('not media'));

    await expect(processor.process(job(0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(processing.markFailed).toHaveBeenCalledWith(
      'video-1',
      'INVALID_MEDIA',
    );
  });

  it('marks a missing source failed without retrying', async () => {
    processing.process.mockRejectedValue(new SourceMissingError('k'));

    await expect(processor.process(job(0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(processing.markFailed).toHaveBeenCalledWith(
      'video-1',
      'SOURCE_MISSING',
    );
  });

  it('rethrows a transient error without failing the video until the last attempt', async () => {
    const transient = new FfmpegError('ffprobe', 'timed out');
    processing.process.mockRejectedValue(transient);

    await expect(processor.process(job(0))).rejects.toBe(transient);
    await expect(processor.process(job(1))).rejects.toBe(transient);
    expect(processing.markFailed).not.toHaveBeenCalled();

    await expect(processor.process(job(2))).rejects.toBe(transient);
    expect(processing.markFailed).toHaveBeenCalledTimes(1);
    expect(processing.markFailed).toHaveBeenCalledWith(
      'video-1',
      'PROCESSING_FAILED',
    );
  });
});
