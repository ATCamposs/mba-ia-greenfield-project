import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Channel } from '../src/channels/entities/channel.entity';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import { Video } from '../src/videos/entities/video.entity';
import {
  createVideoTestApp,
  registerConfirmAndLogin,
} from './helpers/video-e2e';

const SOURCE = Buffer.alloc(2000, 5);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

describe('Video playback (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let clearThrottle: () => void;
  let channel: Channel;
  const keys: string[] = [];

  beforeAll(async () => {
    ({ app, clearThrottle } = await createVideoTestApp());
    dataSource = app.get(DataSource);
    storage = app.get(StorageService, { strict: false });
  });

  afterAll(async () => {
    await Promise.all(keys.map((key) => storage.deleteObject(key)));
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    clearThrottle();
    await registerConfirmAndLogin(app, 'watch-owner@example.com');
    channel = (await dataSource.getRepository(Channel).find())[0];
  });

  async function seedVideo(
    publicId: string,
    status: VideoStatus,
  ): Promise<Video> {
    const id = randomUUID();
    const sourceKey = `videos/${id}/source`;
    const thumbnailKey = `videos/${id}/thumbnail.jpg`;
    keys.push(sourceKey, thumbnailKey);
    await storage.putObject(sourceKey, SOURCE, 'video/mp4');
    await storage.putObject(thumbnailKey, JPEG, 'image/jpeg');
    return dataSource.getRepository(Video).save({
      id,
      public_id: publicId,
      channel_id: channel.id,
      title: 'Seeded',
      status,
      original_filename: 'my clip.mp4',
      content_type: 'video/mp4',
      size_bytes: SOURCE.length,
      part_size_bytes: 104857600,
      source_key: sourceKey,
      thumbnail_key: thumbnailKey,
      duration_seconds: status === VideoStatus.Ready ? 3.5 : null,
      metadata:
        status === VideoStatus.Ready
          ? {
              format: 'mov,mp4',
              bit_rate: 1000,
              video: { codec: 'h264', width: 640, height: 360, frame_rate: 25 },
              audio: null,
            }
          : null,
    });
  }

  it('returns the public details of a ready video without any token', async () => {
    await seedVideo('READYREADY1', VideoStatus.Ready);

    const res = await request(app.getHttpServer())
      .get('/videos/READYREADY1')
      .expect(200);

    expect(res.body).toMatchObject({
      public_id: 'READYREADY1',
      title: 'Seeded',
      duration_seconds: 3.5,
      size_bytes: 2000,
      content_type: 'video/mp4',
      stream_url: '/videos/READYREADY1/stream',
      download_url: '/videos/READYREADY1/download',
      thumbnail_url: '/videos/READYREADY1/thumbnail',
    });
    expect(res.body.metadata.video.codec).toBe('h264');
  });

  it('redirects /stream to a presigned URL that serves ranged reads with 206', async () => {
    await seedVideo('READYREADY2', VideoStatus.Ready);

    const res = await request(app.getHttpServer())
      .get('/videos/READYREADY2/stream')
      .expect(302);

    expect(res.headers['cache-control']).toBe('no-store');
    const ranged = await fetch(res.headers.location, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);
  });

  it('redirects /download to an attachment with the original file name', async () => {
    await seedVideo('READYREADY3', VideoStatus.Ready);

    const res = await request(app.getHttpServer())
      .get('/videos/READYREADY3/download')
      .expect(302);

    const file = await fetch(res.headers.location);
    expect(file.headers.get('content-disposition')).toContain(
      'attachment; filename="my clip.mp4"',
    );
    expect((await file.arrayBuffer()).byteLength).toBe(SOURCE.length);
  });

  it('redirects /thumbnail to the stored JPEG', async () => {
    await seedVideo('READYREADY4', VideoStatus.Ready);

    const res = await request(app.getHttpServer())
      .get('/videos/READYREADY4/thumbnail')
      .expect(302);

    const image = Buffer.from(
      await (await fetch(res.headers.location)).arrayBuffer(),
    );
    expect(image.subarray(0, 3)).toEqual(JPEG.subarray(0, 3));
  });

  it.each([VideoStatus.Draft, VideoStatus.Processing, VideoStatus.Failed])(
    'answers 404 VIDEO_NOT_FOUND on every public route for a %s video',
    async (status) => {
      const publicId = `NOTREADY${status.slice(0, 3).toUpperCase()}`;
      await seedVideo(publicId, status);

      for (const suffix of ['', '/stream', '/download', '/thumbnail']) {
        const res = await request(app.getHttpServer())
          .get(`/videos/${publicId}${suffix}`)
          .expect(404);
        expect(res.body.error).toBe('VIDEO_NOT_FOUND');
      }
    },
  );

  it('answers 404 for an unknown and a malformed id', async () => {
    await request(app.getHttpServer()).get('/videos/UNKNOWNID12').expect(404);
    await request(app.getHttpServer()).get('/videos/not-an-id').expect(404);
  });
});
