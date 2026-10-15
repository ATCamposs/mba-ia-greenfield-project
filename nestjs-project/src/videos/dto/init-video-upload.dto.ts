import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

export class InitVideoUploadDto {
  /** Original file name, used for the default title and the download name. */
  @IsString()
  @Length(1, 255)
  filename: string;

  /** Declared media type: video/mp4, video/quicktime, video/webm or video/x-matroska. */
  @IsString()
  @IsNotEmpty()
  content_type: string;

  /** File size in bytes (the maximum is enforced by the service: 10 GiB). */
  @IsInt()
  @Min(1)
  size_bytes: number;

  /** Optional title (defaults to the file name without extension). */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;
}
