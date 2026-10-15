import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  VideoInvalidStatusException,
  VideoNotFoundException,
  VideoUploadIncompleteException,
} from '../common/exceptions/domain.exception';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { QueueModule } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './video-queue.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const GIB = 1024 ** 3;

// Real MinIO/ffmpeg calls: the 5 s default flakes when the host is busy.
jest.setTimeout(30_000);

describe('VideosService upload lifecycle (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let queue: Queue;
  let counter = 0;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        QueueModule,
        VideosModule,
      ],
    }).compile();
    await module.init();
    service = module.get(VideosService);
    storage = module.get(StorageService, { strict: false });
    dataSource = module.get(DataSource);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE), {
      strict: false,
    });
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await abortOpenUploads();
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  // Leftover multipart uploads would otherwise accumulate in the test bucket.
  async function abortOpenUploads() {
    const open = await dataSource
      .getRepository(Video)
      .find({ where: { status: VideoStatus.Draft } });
    await Promise.all(
      open.map((v) =>
        storage.abortMultipartUpload(v.source_key, v.upload_id as string),
      ),
    );
  }

  async function createUserWithChannel(): Promise<User> {
    const user = await dataSource.getRepository(User).save({
      email: `videos_svc_${++counter}@example.com`,
      password: 'hashed',
    });
    await dataSource.getRepository(Channel).save({
      name: 'Channel',
      nickname: `videossvc${counter}`,
      user_id: user.id,
    });
    return user;
  }

  it('persists a draft with the multipart upload and plans 103 parts for 10 GiB', async () => {
    const user = await createUserWithChannel();

    const plan = await service.initUpload(user.id, {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 10 * GIB,
    });

    expect(plan.part_count).toBe(103);
    expect(plan.parts).toHaveLength(103);
    const stored = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: plan.video.public_id });
    expect(stored.status).toBe(VideoStatus.Draft);
    expect(stored.title).toBe('clip');
    expect(stored.upload_id).toEqual(expect.any(String));
    expect(stored.source_key).toBe(`videos/${stored.id}/source`);
    expect(stored.part_size_bytes).toBe(104857600);
    expect(stored.size_bytes).toBe(10 * GIB);
  });

  it('issues part URLs the storage accepts', async () => {
    const user = await createUserWithChannel();
    const plan = await service.initUpload(user.id, {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
    });

    const response = await fetch(plan.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(1024, 7)),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeTruthy();
  });

  it('does not reveal a video to another user and refreshes URLs for the owner', async () => {
    const owner = await createUserWithChannel();
    const other = await createUserWithChannel();
    const plan = await service.initUpload(owner.id, {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 250 * 1024 ** 2,
    });

    await expect(
      service.findOwnedByPublicId(other.id, plan.video.public_id),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
    const refreshed = await service.refreshPartUrls(
      owner.id,
      plan.video.public_id,
      [3],
    );
    expect(refreshed.parts).toHaveLength(1);
    expect(refreshed.parts[0].part_number).toBe(3);
  });

  async function initSinglePartUpload(userId: string, bytes = 2048) {
    const plan = await service.initUpload(userId, {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: bytes,
    });
    const response = await fetch(plan.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(bytes, 9)),
    });
    const etag = response.headers.get('etag') as string;
    return { plan, parts: [{ part_number: 1, etag }] };
  }

  it('completes the upload: processing status, real size and exactly one job', async () => {
    const user = await createUserWithChannel();
    const { plan, parts } = await initSinglePartUpload(user.id);

    const completed = await service.completeUpload(
      user.id,
      plan.video.public_id,
      parts,
    );

    expect(completed.status).toBe(VideoStatus.Processing);
    const stored = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: plan.video.id });
    expect(stored.status).toBe(VideoStatus.Processing);
    expect(stored.size_bytes).toBe(2048);
    expect(stored.upload_id).toBeNull();
    expect(await storage.headObjectSize(stored.source_key)).toBe(2048);
    const job = await queue.getJob(`video-${stored.id}`);
    expect(job?.data).toEqual({ videoId: stored.id });
    await expect(
      service.completeUpload(user.id, plan.video.public_id, parts),
    ).rejects.toBeInstanceOf(VideoInvalidStatusException);
    expect((await queue.getJobCounts('waiting')).waiting).toBe(1);
  });

  it('keeps the video a draft when the storage rejects the parts', async () => {
    const user = await createUserWithChannel();
    const { plan } = await initSinglePartUpload(user.id);

    await expect(
      service.completeUpload(user.id, plan.video.public_id, [
        { part_number: 1, etag: '"wrong"' },
      ]),
    ).rejects.toBeInstanceOf(VideoUploadIncompleteException);

    const stored = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: plan.video.id });
    expect(stored.status).toBe(VideoStatus.Draft);
    expect((await queue.getJobCounts('waiting')).waiting).toBe(0);
  });

  it('aborts a draft: row removed and part URLs unusable', async () => {
    const user = await createUserWithChannel();
    const plan = await service.initUpload(user.id, {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 2048,
    });

    await service.abortUpload(user.id, plan.video.public_id);

    expect(await dataSource.getRepository(Video).count()).toBe(0);
    const late = await fetch(plan.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(16)),
    });
    expect(late.ok).toBe(false);
  });

  it('refuses to abort a video that is already processing', async () => {
    const user = await createUserWithChannel();
    const { plan, parts } = await initSinglePartUpload(user.id);
    await service.completeUpload(user.id, plan.video.public_id, parts);

    await expect(
      service.abortUpload(user.id, plan.video.public_id),
    ).rejects.toBeInstanceOf(VideoInvalidStatusException);
  });
});
