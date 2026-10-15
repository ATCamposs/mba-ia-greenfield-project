import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  /** Part number (1-based) as issued at initialization. */
  @IsInt()
  @Min(1)
  part_number: number;

  /** ETag header returned by the storage when the part was uploaded. */
  @IsString()
  @Length(1, 256)
  etag: string;
}

export class CompleteVideoUploadDto {
  /** Every uploaded part, exactly once. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
