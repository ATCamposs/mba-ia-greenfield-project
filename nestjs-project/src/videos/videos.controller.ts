import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { InitVideoUploadDto } from './dto/init-video-upload.dto';
import { RefreshPartUrlsDto } from './dto/refresh-part-urls.dto';
import {
  CompleteVideoUploadResponse,
  InitVideoUploadResponse,
  RefreshPartUrlsResponse,
  VideoStatusResponse,
} from './dto/video-upload-responses.dto';
import { VideosService } from './videos.service';

const ORCHESTRATION_THROTTLE = { default: { limit: 60, ttl: 60000 } };
const READ_THROTTLE = { default: { limit: 120, ttl: 60000 } };

const errorResponse = (status: number, description: string) =>
  ApiResponse({
    status,
    description,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  });

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Throttle(ORCHESTRATION_THROTTLE)
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and opens an S3 multipart upload. The client sends each part straight to the storage using the returned presigned URLs, then calls the complete endpoint.',
  })
  @ApiResponse({ status: 201, type: InitVideoUploadResponse })
  @errorResponse(400, 'Validation failed')
  @errorResponse(401, 'Missing or invalid access token')
  @errorResponse(404, 'The user has no channel')
  @errorResponse(413, 'File larger than the 10 GiB limit')
  @errorResponse(415, 'Unsupported video content type')
  @errorResponse(429, 'Too many requests')
  async initUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitVideoUploadDto,
  ): Promise<InitVideoUploadResponse> {
    const plan = await this.videosService.initUpload(user.sub, dto);
    return {
      public_id: plan.video.public_id,
      title: plan.video.title,
      status: plan.video.status,
      part_size_bytes: plan.part_size_bytes,
      part_count: plan.part_count,
      expires_in_seconds: plan.expires_in_seconds,
      parts: plan.parts,
    };
  }

  @Post(':publicId/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh part upload URLs',
    description: 'Issues fresh presigned URLs for parts of a draft upload.',
  })
  @ApiResponse({ status: 200, type: RefreshPartUrlsResponse })
  @errorResponse(400, 'Validation failed or part number out of range')
  @errorResponse(401, 'Missing or invalid access token')
  @errorResponse(404, 'Video not found')
  @errorResponse(409, 'The video is not a draft')
  @errorResponse(429, 'Too many requests')
  refreshPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: RefreshPartUrlsDto,
  ): Promise<RefreshPartUrlsResponse> {
    return this.videosService.refreshPartUrls(
      user.sub,
      publicId,
      dto.part_numbers,
    );
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload, verifies the final size, moves the video to processing and enqueues the background job.',
  })
  @ApiResponse({ status: 202, type: CompleteVideoUploadResponse })
  @errorResponse(400, 'Validation failed')
  @errorResponse(401, 'Missing or invalid access token')
  @errorResponse(404, 'Video not found')
  @errorResponse(409, 'The video is not a draft')
  @errorResponse(413, 'Uploaded file larger than the 10 GiB limit')
  @errorResponse(422, 'Parts incomplete or rejected by the storage')
  @errorResponse(429, 'Too many requests')
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteVideoUploadDto,
  ): Promise<CompleteVideoUploadResponse> {
    const video = await this.videosService.completeUpload(
      user.sub,
      publicId,
      dto.parts,
    );
    return { public_id: video.public_id, status: video.status };
  }

  @Delete(':publicId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the multipart upload and removes the draft. Only drafts can be aborted.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @errorResponse(401, 'Missing or invalid access token')
  @errorResponse(404, 'Video not found')
  @errorResponse(409, 'The video is not a draft')
  @errorResponse(429, 'Too many requests')
  abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, publicId);
  }

  @Get(':publicId/status')
  @Throttle(READ_THROTTLE)
  @ApiOperation({
    summary: 'Get the processing status of an own video',
    description:
      'Lets the uploader poll the draft, processing, ready or failed state.',
  })
  @ApiResponse({ status: 200, type: VideoStatusResponse })
  @errorResponse(401, 'Missing or invalid access token')
  @errorResponse(404, 'Video not found')
  @errorResponse(429, 'Too many requests')
  async getStatus(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoStatusResponse> {
    const video = await this.videosService.findOwnedByPublicId(
      user.sub,
      publicId,
    );
    return {
      public_id: video.public_id,
      status: video.status,
      failure_reason: video.failure_reason,
    };
  }
}
