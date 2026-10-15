import { registerAs } from '@nestjs/config';

export default registerAs('videos', () => ({
  maxSizeBytes: parseInt(process.env.VIDEO_MAX_SIZE_BYTES || '10737418240', 10),
  partSizeBytes: parseInt(process.env.VIDEO_PART_SIZE_BYTES || '104857600', 10),
  uploadUrlTtlSeconds: parseInt(
    process.env.VIDEO_UPLOAD_URL_TTL_SECONDS || '21600',
    10,
  ),
  playbackUrlTtlSeconds: parseInt(
    process.env.VIDEO_PLAYBACK_URL_TTL_SECONDS || '21600',
    10,
  ),
}));
