import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface TestVideoOptions {
  seconds?: number;
  size?: string;
  videoBitrate?: string;
  audio?: boolean;
  // High-entropy video that stays large (about 13 MiB per second at 1280x720).
  noise?: boolean;
}

// Synthetic media from ffmpeg's lavfi sources, so tests need no binary fixtures.
export function generateTestVideo(
  options: TestVideoOptions = {},
): Promise<string> {
  const {
    seconds = 3,
    size = '320x240',
    videoBitrate,
    audio = true,
    noise = false,
  } = options;
  const outputPath = join(tmpdir(), `streamtube-test-${randomUUID()}.mp4`);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    noise
      ? `nullsrc=size=${size}:rate=25,geq=random(1)*255:128:128`
      : `testsrc=duration=${seconds}:size=${size}:rate=25`,
    ...(audio
      ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`]
      : []),
    ...(noise ? ['-t', String(seconds)] : []),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    ...(videoBitrate ? ['-b:v', videoBitrate, '-minrate', videoBitrate] : []),
    ...(audio ? ['-c:a', 'aac'] : []),
    '-movflags',
    '+faststart',
    '-y',
    outputPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(outputPath)
        : reject(new Error(`ffmpeg failed (${code}): ${stderr}`)),
    );
  });
}
