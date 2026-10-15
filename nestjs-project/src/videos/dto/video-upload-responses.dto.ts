import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video-status.enum';

export class PartUrlResponse {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    description:
      'Presigned URL: send the part bytes with PUT and keep the ETag response header.',
  })
  url: string;
}

export class InitVideoUploadResponse {
  @ApiProperty({
    example: 'dQw4w9WgXcQ',
    description: '11-character public id',
  })
  public_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.Draft })
  status: VideoStatus;

  @ApiProperty({ example: 104857600 })
  part_size_bytes: number;

  @ApiProperty({ example: 103 })
  part_count: number;

  @ApiProperty({ example: 21600 })
  expires_in_seconds: number;

  @ApiProperty({ type: [PartUrlResponse] })
  parts: PartUrlResponse[];
}

export class RefreshPartUrlsResponse {
  @ApiProperty({ example: 21600 })
  expires_in_seconds: number;

  @ApiProperty({ type: [PartUrlResponse] })
  parts: PartUrlResponse[];
}

export class CompleteVideoUploadResponse {
  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  public_id: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.Processing })
  status: VideoStatus;
}

export class VideoStatusResponse {
  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  public_id: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ nullable: true, type: String, example: null })
  failure_reason: string | null;
}
