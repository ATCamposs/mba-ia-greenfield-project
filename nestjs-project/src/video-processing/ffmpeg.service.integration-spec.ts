import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateTestVideo } from '../test/generate-test-video';
import { FfmpegService } from './ffmpeg.service';
import { InvalidMediaError } from './probe-result';

// Real MinIO/ffmpeg calls: the 5 s default flakes when the host is busy.
jest.setTimeout(30_000);

describe('FfmpegService (integration, real ffmpeg/ffprobe)', () => {
  const service = new FfmpegService();
  const files: string[] = [];

  afterAll(async () => {
    await Promise.all(files.map((file) => rm(file, { force: true })));
  });

  const track = (path: string) => {
    files.push(path);
    return path;
  };

  it('probes duration, container, codec and resolution of a generated video', async () => {
    const video = track(await generateTestVideo({ seconds: 3 }));

    const { durationSeconds, metadata } = await service.probe(video);

    expect(durationSeconds).toBeGreaterThan(2.5);
    expect(durationSeconds).toBeLessThan(3.5);
    expect(metadata.format).toContain('mp4');
    expect(metadata.video).toMatchObject({
      codec: 'h264',
      width: 320,
      height: 240,
      frame_rate: 25,
    });
    expect(metadata.audio?.codec).toBe('aac');
  }, 60000);

  it('extracts a non-empty JPEG thumbnail scaled down to 1280px wide', async () => {
    const video = track(
      await generateTestVideo({ seconds: 3, size: '1920x1080' }),
    );
    const thumbnail = track(join(tmpdir(), `thumb-${Date.now()}.jpg`));

    await service.extractThumbnail(video, 1, thumbnail);

    expect((await stat(thumbnail)).size).toBeGreaterThan(0);
    const { metadata } = await service.probe(thumbnail);
    expect(metadata.video).toMatchObject({
      codec: 'mjpeg',
      width: 1280,
      height: 720,
    });
  }, 60000);

  it('rejects bytes that are not media', async () => {
    const junk = track(join(tmpdir(), `junk-${Date.now()}.mp4`));
    await writeFile(junk, randomBytes(4096));

    await expect(service.probe(junk)).rejects.toBeInstanceOf(InvalidMediaError);
  }, 30000);

  it('rejects a file that only has an audio stream', async () => {
    const audioOnly = track(join(tmpdir(), `audio-${Date.now()}.m4a`));
    const result = spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:a',
      'aac',
      '-y',
      audioOnly,
    ]);
    expect(result.status).toBe(0);

    await expect(service.probe(audioOnly)).rejects.toBeInstanceOf(
      InvalidMediaError,
    );
  }, 30000);
});
