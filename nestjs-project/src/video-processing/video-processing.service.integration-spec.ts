import { randomBytes, randomUUID } from 'crypto';
import { readFile, rm } from 'fs/promises';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError, Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { generateTestVideo } from '../test/generate-test-video';
import { User } from '../users/entities/user.entity';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

// Real MinIO/ffmpeg calls: the 5 s default flakes when the host is busy.
jest.setTimeout(30_000);

describe('Video processing (integration, real Postgres + MinIO + ffmpeg)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let service: VideoProcessingService;
  let processor: VideoProcessor;
  let channel: Channel;
  const keys: string[] = [];
  const files: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [FfmpegService, VideoProcessingService],
    }).compile();
    await module.init();
    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
    service = module.get(VideoProcessingService);
    processor = new VideoProcessor(service);
  });

  afterAll(async () => {
    await Promise.all(keys.map((key) => storage.deleteObject(key)));
    await Promise.all(files.map((file) => rm(file, { force: true })));
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `processing_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Processing',
      nickname: `proc${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
  });

  async function seed(
    body: Buffer | null,
    status = VideoStatus.Processing,
  ): Promise<Video> {
    const id = randomUUID();
    const sourceKey = `videos/${id}/source`;
    keys.push(sourceKey, `videos/${id}/thumbnail.jpg`);
    if (body) await storage.putObject(sourceKey, body, 'video/mp4');
    return dataSource.getRepository(Video).save({
      id,
      public_id: randomUUID().replace(/-/g, '').slice(0, 11),
      channel_id: channel.id,
      title: 'Processing test',
      status,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: body?.length ?? 1,
      part_size_bytes: 104857600,
      source_key: sourceKey,
    });
  }

  const reload = (id: string) =>
    dataSource.getRepository(Video).findOneByOrFail({ id });

  const job = (videoId: string, attemptsMade = 0) =>
    ({
      data: { videoId },
      attemptsMade,
      opts: { attempts: 3 },
    }) as unknown as Job<{ videoId: string }>;

  async function validVideo(): Promise<Buffer> {
    const path = await generateTestVideo({ seconds: 3 });
    files.push(path);
    return readFile(path);
  }

  it('turns a processing video into ready with duration, metadata and a stored thumbnail', async () => {
    const video = await seed(await validVideo());

    await service.process(video.id);

    const ready = await reload(video.id);
    expect(ready.status).toBe(VideoStatus.Ready);
    expect(ready.duration_seconds).toBeGreaterThan(2.5);
    expect(ready.metadata?.video).toMatchObject({
      codec: 'h264',
      width: 320,
      height: 240,
    });
    expect(ready.metadata?.audio?.codec).toBe('aac');
    expect(ready.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(
      await storage.headObjectSize(ready.thumbnail_key as string),
    ).toBeGreaterThan(0);
  }, 90000);

  it('leaves a finished video untouched when the job is replayed', async () => {
    const video = await seed(await validVideo());
    await service.process(video.id);
    const first = await reload(video.id);

    await service.process(video.id);

    const second = await reload(video.id);
    expect(second.updated_at).toEqual(first.updated_at);
    expect(second.status).toBe(VideoStatus.Ready);
  }, 90000);

  it('does not touch a video that is not processing', async () => {
    const video = await seed(await validVideo(), VideoStatus.Draft);

    await service.process(video.id);

    expect((await reload(video.id)).status).toBe(VideoStatus.Draft);
    expect(
      await storage.headObjectSize(`videos/${video.id}/thumbnail.jpg`),
    ).toBeNull();
  }, 90000);

  it('fails non-media content with INVALID_MEDIA on the first attempt', async () => {
    const video = await seed(randomBytes(8192));

    await expect(processor.process(job(video.id))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const failed = await reload(video.id);
    expect(failed.status).toBe(VideoStatus.Failed);
    expect(failed.failure_reason).toBe('INVALID_MEDIA');
  }, 60000);

  it('fails a video whose source object is gone with SOURCE_MISSING', async () => {
    const video = await seed(null);

    await expect(processor.process(job(video.id))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    expect((await reload(video.id)).failure_reason).toBe('SOURCE_MISSING');
  }, 30000);
});
