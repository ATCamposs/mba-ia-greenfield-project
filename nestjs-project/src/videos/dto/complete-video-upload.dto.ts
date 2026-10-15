import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty({
    example: 1,
    minimum: 1,
    description: 'Part number (1-based) as issued at initialization.',
  })
  @IsInt()
  @Min(1)
  part_number: number;

  @ApiProperty({
    example: '"9bb58f26192e4ba00f01e2e7b136bbd8"',
    description:
      'ETag header returned by the storage when the part was uploaded.',
  })
  @IsString()
  @Length(1, 256)
  etag: string;
}

export class CompleteVideoUploadDto {
  @ApiProperty({
    type: [CompletedPartDto],
    description: 'Every uploaded part, each exactly once.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
