import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { InitVideoUploadDto } from './dto/init-video-upload.dto';
import { RefreshPartUrlsDto } from './dto/refresh-part-urls.dto';
import { VideoDetailsResponse } from './dto/video-details.response.dto';
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
@Throttle(ORCHESTRATION_THROTTLE)
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
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
  @ApiBearerAuth('access-token')
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
  @ApiBearerAuth('access-token')
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
  @ApiBearerAuth('access-token')
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
  @ApiBearerAuth('access-token')
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

  @Public()
  @Get(':publicId')
  @Throttle(READ_THROTTLE)
  @ApiOperation({
    summary: 'Get a ready video',
    description:
      'Public details of a ready video, with the relative URLs to stream, download and fetch the thumbnail.',
  })
  @ApiResponse({ status: 200, type: VideoDetailsResponse })
  @errorResponse(404, 'Video not found or not ready')
  @errorResponse(429, 'Too many requests')
  async getVideo(
    @Param('publicId') publicId: string,
  ): Promise<VideoDetailsResponse> {
    const video = await this.videosService.getReadyVideo(publicId);
    const base = `/videos/${video.public_id}`;
    return {
      public_id: video.public_id,
      title: video.title,
      duration_seconds: video.duration_seconds as number,
      size_bytes: video.size_bytes,
      content_type: video.content_type,
      metadata: video.metadata,
      created_at: video.created_at,
      stream_url: `${base}/stream`,
      download_url: `${base}/download`,
      thumbnail_url: `${base}/thumbnail`,
    };
  }

  @Public()
  @Get(':publicId/stream')
  @Throttle(READ_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a ready video',
    description:
      'Redirects (302) to a short-lived presigned storage URL. The storage serves HTTP Range requests (206), so playback starts without downloading the whole file.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the presigned URL' })
  @errorResponse(404, 'Video not found or not ready')
  @errorResponse(429, 'Too many requests')
  async stream(@Param('publicId') publicId: string) {
    return {
      url: await this.videosService.getStreamUrl(publicId),
      statusCode: HttpStatus.FOUND,
    };
  }

  @Public()
  @Get(':publicId/download')
  @Throttle(READ_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @Redirect()
  @ApiOperation({
    summary: 'Download a ready video',
    description:
      'Redirects (302) to a presigned storage URL that forces an attachment download with the original file name.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the presigned URL' })
  @errorResponse(404, 'Video not found or not ready')
  @errorResponse(429, 'Too many requests')
  async download(@Param('publicId') publicId: string) {
    return {
      url: await this.videosService.getDownloadUrl(publicId),
      statusCode: HttpStatus.FOUND,
    };
  }

  @Public()
  @Get(':publicId/thumbnail')
  @Throttle(READ_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @Redirect()
  @ApiOperation({
    summary: 'Get the thumbnail of a ready video',
    description: 'Redirects (302) to a presigned URL of the JPEG thumbnail.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the presigned URL' })
  @errorResponse(404, 'Video not found or not ready')
  @errorResponse(429, 'Too many requests')
  async thumbnail(@Param('publicId') publicId: string) {
    return {
      url: await this.videosService.getThumbnailUrl(publicId),
      statusCode: HttpStatus.FOUND,
    };
  }
}
