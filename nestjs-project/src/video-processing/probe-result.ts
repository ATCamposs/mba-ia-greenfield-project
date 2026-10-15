import type { VideoMetadata } from '../videos/entities/video.entity';

export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  disposition?: { attached_pic?: number };
}

interface ProbeOutput {
  format?: { duration?: string; format_name?: string; bit_rate?: string };
  streams?: ProbeStream[];
}

export interface ProbedMedia {
  durationSeconds: number;
  metadata: VideoMetadata;
}

const toNumber = (value: string | number | undefined): number | null => {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) ? parsed : null;
};

// ffprobe reports frame rates as "num/den"; "0/0" means unknown.
const parseFrameRate = (value: string | undefined): number | null => {
  const [num, den] = (value ?? '').split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const rate = num / den;
  return rate > 0 ? Math.round(rate * 100) / 100 : null;
};

export function parseProbe(output: ProbeOutput): ProbedMedia {
  const streams = output.streams ?? [];
  // Cover art (attached_pic) is exposed as a video stream but is not playable video.
  const video = streams.find(
    (s) => s.codec_type === 'video' && !s.disposition?.attached_pic,
  );
  if (!video) throw new InvalidMediaError('The file has no video stream');

  const durationSeconds = toNumber(output.format?.duration);
  if (durationSeconds === null || durationSeconds <= 0) {
    throw new InvalidMediaError('The file has no positive duration');
  }

  const audio = streams.find((s) => s.codec_type === 'audio');
  return {
    durationSeconds,
    metadata: {
      format: output.format?.format_name ?? null,
      bit_rate: toNumber(output.format?.bit_rate),
      video: {
        codec: video.codec_name ?? null,
        width: video.width ?? null,
        height: video.height ?? null,
        frame_rate: parseFrameRate(video.r_frame_rate),
      },
      audio: audio
        ? {
            codec: audio.codec_name ?? null,
            channels: audio.channels ?? null,
            sample_rate: toNumber(audio.sample_rate),
          }
        : null,
    },
  };
}

// 10% into the video (at least 1s), or the first frame when it is too short to seek.
export function thumbnailSeekSeconds(durationSeconds: number): number {
  if (durationSeconds < 2) return 0;
  return Math.round(Math.max(1, durationSeconds * 0.1) * 1000) / 1000;
}
