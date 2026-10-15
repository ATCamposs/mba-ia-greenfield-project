import { spawn } from 'child_process';
import { stat } from 'fs/promises';
import { Injectable } from '@nestjs/common';
import { InvalidMediaError, parseProbe, ProbedMedia } from './probe-result';

const PROBE_TIMEOUT_MS = 5 * 60 * 1000;
const THUMBNAIL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROBE_OUTPUT_BYTES = 5 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

// Markers ffprobe prints when the bytes are not a decodable media container.
const INVALID_MEDIA_MARKERS = [
  'Invalid data found when processing input',
  'moov atom not found',
  'could not find codec parameters',
  'End of file',
];

export class FfmpegError extends Error {
  constructor(
    public readonly command: string,
    message: string,
  ) {
    super(`${command}: ${message}`);
    this.name = 'FfmpegError';
  }
}

// Reconnect options only exist on the http protocol; local files reject them.
const inputOptions = (input: string): string[] =>
  /^https?:\/\//.test(input)
    ? [
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '5',
      ]
    : [];

@Injectable()
export class FfmpegService {
  async probe(inputUrl: string): Promise<ProbedMedia> {
    let stdout: string;
    try {
      stdout = await this.run(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          ...inputOptions(inputUrl),
          '-i',
          inputUrl,
        ],
        PROBE_TIMEOUT_MS,
      );
    } catch (error) {
      if (
        error instanceof FfmpegError &&
        INVALID_MEDIA_MARKERS.some((marker) => error.message.includes(marker))
      ) {
        throw new InvalidMediaError('The file is not a readable media file');
      }
      throw error;
    }
    try {
      return parseProbe(JSON.parse(stdout));
    } catch (error) {
      if (error instanceof InvalidMediaError) throw error;
      throw new InvalidMediaError('The file could not be probed');
    }
  }

  async extractThumbnail(
    inputUrl: string,
    seekSeconds: number,
    outputPath: string,
  ): Promise<void> {
    await this.run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        ...inputOptions(inputUrl),
        '-ss',
        String(seekSeconds),
        '-i',
        inputUrl,
        '-frames:v',
        '1',
        '-vf',
        "scale='min(1280,iw)':-2",
        '-q:v',
        '3',
        '-y',
        outputPath,
      ],
      THUMBNAIL_TIMEOUT_MS,
    );
    const { size } = await stat(outputPath).catch(() => ({ size: 0 }));
    if (size === 0) {
      throw new FfmpegError('ffmpeg', 'no frame could be extracted');
    }
  }

  // Arguments are passed as an array so nothing is ever interpreted by a shell.
  private run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrTail = '';
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(Buffer.concat(stdout).toString('utf8'));
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new FfmpegError(command, `timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_PROBE_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish(new FfmpegError(command, 'output too large'));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(
          -STDERR_TAIL_BYTES,
        );
      });
      child.on('error', (error) =>
        finish(new FfmpegError(command, error.message)),
      );
      child.on('close', (code) =>
        code === 0
          ? finish()
          : finish(
              new FfmpegError(
                command,
                `exit code ${code}: ${stderrTail.trim()}`,
              ),
            ),
      );
    });
  }
}
