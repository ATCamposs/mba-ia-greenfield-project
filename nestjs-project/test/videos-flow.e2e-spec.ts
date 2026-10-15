import { randomBytes } from 'crypto';
import { readFile, rm } from 'fs/promises';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import videosConfig from '../src/config/videos.config';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { generateTestVideo } from '../src/test/generate-test-video';
import { VideoProcessingModule } from '../src/video-processing/video-processing.module';
import { Video } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/video-queue.constants';
import {
  createVideoTestApp,
  PartPlan,
  registerConfirmAndLogin,
  uploadParts,
} from './helpers/video-e2e';

const MIB = 1024 * 1024;

describe('Video upload → processing → playback (e2e, in-process worker)', () => {
  let app: INestApplication<App>;
  let clearThrottle: () => void;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: Queue;
  let token: string;
  const files: string[] = [];

  beforeAll(async () => {
    // 5 MiB parts (the S3 minimum) so a ~13 MiB file needs several parts.
    ({ app, clearThrottle } = await createVideoTestApp(
      [VideoProcessingModule],
      (builder) =>
        builder
          .overrideProvider(videosConfig.KEY)
          .useValue({ ...videosConfig(), partSizeBytes: 5 * MIB }),
    ));
    dataSource = app.get(DataSource);
    storage = app.get(StorageService, { strict: false });
    queue = app.get(getQueueToken(VIDEO_PROCESSING_QUEUE), { strict: false });
  });

  afterAll(async () => {
    const videos = await dataSource.getRepository(Video).find();
    await Promise.all(
      videos.flatMap((video) =>
        [video.source_key, video.thumbnail_key]
          .filter((key): key is string => !!key)
          .map((key) => storage.deleteObject(key)),
      ),
    );
    await Promise.all(files.map((file) => rm(file, { force: true })));
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    clearThrottle();
    token = await registerConfirmAndLogin(app, 'flow@example.com');
  });

  const authed = (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  async function initUpload(content: Buffer, filename = 'flow video.mp4') {
    const res = await authed(request(app.getHttpServer()).post('/videos'))
      .send({
        filename,
        content_type: 'video/mp4',
        size_bytes: content.length,
      })
      .expect(201);
    return res.body as PartPlan & { public_id: string; part_count: number };
  }

  async function completeAndWait(
    plan: PartPlan & { public_id: string },
    content: Buffer,
  ) {
    const parts = await uploadParts(plan, content);
    await authed(
      request(app.getHttpServer()).post(
        `/videos/${plan.public_id}/upload/complete`,
      ),
    )
      .send({ parts })
      .expect(202);

    const deadline = Date.now() + 60000;
    for (;;) {
      const status = await authed(
        request(app.getHttpServer()).get(`/videos/${plan.public_id}/status`),
      ).expect(200);
      if (['ready', 'failed'].includes(status.body.status)) return status.body;
      if (Date.now() > deadline) throw new Error('Processing did not finish');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  it('uploads a multi-part video straight to the storage, processes it and serves it', async () => {
    const path = await generateTestVideo({
      seconds: 1,
      size: '1280x720',
      noise: true,
    });
    files.push(path);
    const content = await readFile(path);
    expect(content.length).toBeGreaterThan(10 * MIB);

    const plan = await initUpload(content);
    expect(plan.part_count).toBeGreaterThanOrEqual(3);

    const finished = await completeAndWait(plan, content);
    expect(finished).toMatchObject({ status: 'ready', failure_reason: null });

    const details = await request(app.getHttpServer())
      .get(`/videos/${plan.public_id}`)
      .expect(200);
    expect(details.body.duration_seconds).toBeGreaterThan(0.5);
    expect(details.body.size_bytes).toBe(content.length);
    expect(details.body.title).toBe('flow video');
    expect(details.body.metadata.video).toMatchObject({
      codec: 'h264',
      width: 1280,
      height: 720,
    });

    const stream = await request(app.getHttpServer())
      .get(details.body.stream_url)
      .expect(302);
    const ranged = await fetch(stream.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(1024);

    const download = await request(app.getHttpServer())
      .get(details.body.download_url)
      .expect(302);
    const file = await fetch(download.headers.location, {
      headers: { Range: 'bytes=0-9' },
    });
    expect(file.headers.get('content-disposition')).toContain(
      'attachment; filename="flow video.mp4"',
    );

    const thumbnail = await request(app.getHttpServer())
      .get(details.body.thumbnail_url)
      .expect(302);
    const image = Buffer.from(
      await (await fetch(thumbnail.headers.location)).arrayBuffer(),
    );
    expect(image.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  }, 120000);

  it('fails content that is not media and hides it from the public routes', async () => {
    const content = randomBytes(6 * MIB);
    const plan = await initUpload(content, 'fake.mp4');

    const finished = await completeAndWait(plan, content);

    expect(finished).toEqual({
      public_id: plan.public_id,
      status: 'failed',
      failure_reason: 'INVALID_MEDIA',
    });
    await request(app.getHttpServer())
      .get(`/videos/${plan.public_id}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/videos/${plan.public_id}/stream`)
      .expect(404);
  }, 120000);

  it('gives different public ids to two uploads of the same user', async () => {
    const small = Buffer.alloc(2048, 1);

    const first = await initUpload(small);
    const second = await initUpload(small);

    expect(first.public_id).not.toBe(second.public_id);
    for (const plan of [first, second]) {
      await authed(
        request(app.getHttpServer()).delete(`/videos/${plan.public_id}/upload`),
      ).expect(204);
    }
  });
});
