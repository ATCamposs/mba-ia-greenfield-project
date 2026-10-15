import { ApiProperty } from '@nestjs/swagger';
import type { VideoMetadata } from '../entities/video.entity';

export class VideoDetailsResponse {
  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  public_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ example: 212.48, description: 'Duration in seconds' })
  duration_seconds: number;

  @ApiProperty({ example: 52428800 })
  size_bytes: number;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Technical metadata extracted by the worker: format, bit_rate, video and audio streams.',
  })
  metadata: VideoMetadata | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: Date;

  @ApiProperty({ example: '/videos/dQw4w9WgXcQ/stream' })
  stream_url: string;

  @ApiProperty({ example: '/videos/dQw4w9WgXcQ/download' })
  download_url: string;

  @ApiProperty({ example: '/videos/dQw4w9WgXcQ/thumbnail' })
  thumbnail_url: string;
}
