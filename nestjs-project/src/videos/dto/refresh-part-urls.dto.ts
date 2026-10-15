import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';

export class RefreshPartUrlsDto {
  /** Part numbers (1-based) that need a fresh presigned URL. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
