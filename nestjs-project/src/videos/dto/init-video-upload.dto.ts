import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

export class InitVideoUploadDto {
  @ApiProperty({
    example: 'holiday.mp4',
    description: 'Original file name, used for the default title and download.',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @Length(1, 255)
  filename: string;

  @ApiProperty({
    example: 'video/mp4',
    description:
      'Declared media type: video/mp4, video/quicktime, video/webm or video/x-matroska.',
  })
  @IsString()
  @IsNotEmpty()
  content_type: string;

  @ApiProperty({
    example: 52428800,
    minimum: 1,
    description:
      'File size in bytes (maximum 10 GiB, enforced by the service).',
  })
  @IsInt()
  @Min(1)
  size_bytes: number;

  @ApiPropertyOptional({
    example: 'My holiday',
    minLength: 1,
    maxLength: 100,
    description: 'Defaults to the file name without extension.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;
}
