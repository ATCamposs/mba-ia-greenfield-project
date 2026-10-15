import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/video-queue.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createVideoTestApp,
  registerConfirmAndLogin,
  uploadParts,
} from './helpers/video-e2e';

describe('Video upload orchestration (e2e)', () => {
  let app: INestApplication<App>;
  let clearThrottle: () => void;
  let dataSource: DataSource;
  let queue: Queue;
  let storage: StorageService;
  let owner: string;
  let stranger: string;

  beforeAll(async () => {
    ({ app, clearThrottle } = await createVideoTestApp());
    dataSource = app.get(DataSource);
    queue = app.get(getQueueToken(VIDEO_PROCESSING_QUEUE), { strict: false });
    storage = app.get(StorageService, { strict: false });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const open = await dataSource
      .getRepository(Video)
      .find({ where: { status: VideoStatus.Draft } });
    await Promise.all(
      open.map((v) =>
        storage.abortMultipartUpload(v.source_key, v.upload_id as string),
      ),
    );
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    clearThrottle();
    owner = await registerConfirmAndLogin(app, 'owner@example.com');
    stranger = await registerConfirmAndLogin(app, 'stranger@example.com');
  });

  const init = (token: string, body: object = {}) =>
    request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'my clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 4096,
        ...body,
      });

  describe('POST /videos', () => {
    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 1 })
        .expect(401);
    });

    it('returns 201 with the draft and the presigned part URLs', async () => {
      const res = await init(owner).expect(201);

      expect(res.body.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(res.body.status).toBe('draft');
      expect(res.body.title).toBe('my clip');
      expect(res.body.part_count).toBe(1);
      expect(res.body.part_size_bytes).toBe(104857600);
      expect(res.body.parts).toHaveLength(1);
      expect(res.body.parts[0].url).toContain('X-Amz-Signature');
    });

    it('returns 400 VALIDATION_ERROR for an unknown property or a negative size', async () => {
      const unknown = await init(owner, { extra: true }).expect(400);
      const negative = await init(owner, { size_bytes: -5 }).expect(400);

      expect(unknown.body.error).toBe('VALIDATION_ERROR');
      expect(negative.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 413 above 10 GiB and 415 for a non-video type', async () => {
      const big = await init(owner, { size_bytes: 10 * 1024 ** 3 + 1 }).expect(
        413,
      );
      const pdf = await init(owner, { content_type: 'application/pdf' }).expect(
        415,
      );

      expect(big.body.error).toBe('VIDEO_FILE_TOO_LARGE');
      expect(pdf.body.error).toBe('UNSUPPORTED_VIDEO_TYPE');
    });
  });

  describe('upload lifecycle', () => {
    it('completes an upload sent straight to the storage and exposes the status', async () => {
      const content = Buffer.alloc(4096, 3);
      const created = (await init(owner)).body;
      const parts = await uploadParts(created, content);

      const complete = await request(app.getHttpServer())
        .post(`/videos/${created.public_id}/upload/complete`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ parts })
        .expect(202);

      expect(complete.body).toEqual({
        public_id: created.public_id,
        status: 'processing',
      });
      const status = await request(app.getHttpServer())
        .get(`/videos/${created.public_id}/status`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(status.body).toEqual({
        public_id: created.public_id,
        status: 'processing',
        failure_reason: null,
      });
    });

    it('returns 409 VIDEO_INVALID_STATUS when completing twice', async () => {
      const created = (await init(owner)).body;
      const parts = await uploadParts(created, Buffer.alloc(4096, 1));
      const complete = () =>
        request(app.getHttpServer())
          .post(`/videos/${created.public_id}/upload/complete`)
          .set('Authorization', `Bearer ${owner}`)
          .send({ parts });
      await complete().expect(202);

      const second = await complete().expect(409);

      expect(second.body.error).toBe('VIDEO_INVALID_STATUS');
    });

    it('returns 422 VIDEO_UPLOAD_INCOMPLETE when a part is missing', async () => {
      const created = (await init(owner, { size_bytes: 250 * 1024 ** 2 })).body;

      const res = await request(app.getHttpServer())
        .post(`/videos/${created.public_id}/upload/complete`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ parts: [{ part_number: 1, etag: '"abc"' }] })
        .expect(422);

      expect(res.body.error).toBe('VIDEO_UPLOAD_INCOMPLETE');
    });

    it('refreshes part URLs and rejects out-of-range part numbers', async () => {
      const created = (await init(owner, { size_bytes: 250 * 1024 ** 2 })).body;
      const refresh = (part_numbers: number[]) =>
        request(app.getHttpServer())
          .post(`/videos/${created.public_id}/upload/parts`)
          .set('Authorization', `Bearer ${owner}`)
          .send({ part_numbers });

      const ok = await refresh([2]).expect(200);
      const bad = await refresh([9]).expect(400);

      expect(ok.body.parts).toHaveLength(1);
      expect(ok.body.parts[0].part_number).toBe(2);
      expect(bad.body.error).toBe('INVALID_PART_NUMBER');
    });

    it('aborts a draft with 204 and then answers 404 for its status', async () => {
      const created = (await init(owner)).body;

      await request(app.getHttpServer())
        .delete(`/videos/${created.public_id}/upload`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/videos/${created.public_id}/status`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(404);
    });
  });

  describe('ownership', () => {
    it('returns 404 VIDEO_NOT_FOUND to another user on every owner-only route', async () => {
      const created = (await init(owner)).body;
      const asStranger = (req: request.Test) =>
        req.set('Authorization', `Bearer ${stranger}`);
      const base = `/videos/${created.public_id}`;

      const responses = await Promise.all([
        asStranger(request(app.getHttpServer()).get(`${base}/status`)),
        asStranger(request(app.getHttpServer()).delete(`${base}/upload`)),
        asStranger(
          request(app.getHttpServer())
            .post(`${base}/upload/parts`)
            .send({ part_numbers: [1] }),
        ),
        asStranger(
          request(app.getHttpServer())
            .post(`${base}/upload/complete`)
            .send({ parts: [{ part_number: 1, etag: '"x"' }] }),
        ),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('VIDEO_NOT_FOUND');
      }
    });
  });
});
