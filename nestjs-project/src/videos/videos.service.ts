import { randomUUID } from 'crypto';
import { parse } from 'path';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videosConfig from '../config/videos.config';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  UnsupportedVideoTypeException,
  VideoFileTooLargeException,
  VideoInvalidStatusException,
  VideoNotFoundException,
  VideoUploadIncompleteException,
} from '../common/exceptions/domain.exception';
import {
  MultipartUploadRejectedError,
  StorageService,
} from '../storage/storage.service';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import { generatePublicId, isPublicId } from './public-id.util';
import { ALLOWED_VIDEO_CONTENT_TYPES } from './video-content-types';
import { VideoQueueService } from './video-queue.service';

const PG_UNIQUE_VIOLATION = '23505';
const MAX_PUBLIC_ID_ATTEMPTS = 5;
const MAX_TITLE_LENGTH = 100;

export interface InitUploadInput {
  filename: string;
  content_type: string;
  size_bytes: number;
  title?: string;
}

export interface PartUrl {
  part_number: number;
  url: string;
}

export interface CompletedPartInput {
  part_number: number;
  etag: string;
}

export interface UploadPlan {
  video: Video;
  part_size_bytes: number;
  part_count: number;
  expires_in_seconds: number;
  parts: PartUrl[];
}

function isPublicIdCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, detail } = error as QueryFailedError & {
    code?: string;
    detail?: string;
  };
  return (
    code === PG_UNIQUE_VIOLATION && String(detail ?? '').includes('public_id')
  );
}

function titleFromFilename(filename: string): string {
  const base = parse(filename).name.trim();
  return (base || 'Untitled video').slice(0, MAX_TITLE_LENGTH);
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    private readonly queue: VideoQueueService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  async initUpload(
    userId: string,
    input: InitUploadInput,
  ): Promise<UploadPlan> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();
    if (input.size_bytes > this.config.maxSizeBytes) {
      throw new VideoFileTooLargeException(this.config.maxSizeBytes);
    }
    if (
      !(ALLOWED_VIDEO_CONTENT_TYPES as readonly string[]).includes(
        input.content_type,
      )
    ) {
      throw new UnsupportedVideoTypeException(input.content_type);
    }

    const id = randomUUID();
    const sourceKey = `videos/${id}/source`;
    const uploadId = await this.storage.createMultipartUpload(
      sourceKey,
      input.content_type,
    );

    let video: Video;
    try {
      video = await this.insertDraft(
        id,
        sourceKey,
        uploadId,
        channel.id,
        input,
      );
    } catch (error) {
      await this.storage.abortMultipartUpload(sourceKey, uploadId);
      throw error;
    }

    const partCount = this.partCount(video);
    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    return {
      video,
      part_size_bytes: video.part_size_bytes,
      part_count: partCount,
      expires_in_seconds: this.config.uploadUrlTtlSeconds,
      parts: await this.presignParts(video, partNumbers),
    };
  }

  async refreshPartUrls(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<{ expires_in_seconds: number; parts: PartUrl[] }> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.status !== VideoStatus.Draft) {
      throw new VideoInvalidStatusException(video.status);
    }
    const partCount = this.partCount(video);
    if (
      partNumbers.some((n) => !Number.isInteger(n) || n < 1 || n > partCount)
    ) {
      throw new InvalidPartNumberException(partCount);
    }
    return {
      expires_in_seconds: this.config.uploadUrlTtlSeconds,
      parts: await this.presignParts(video, partNumbers),
    };
  }

  async completeUpload(
    userId: string,
    publicId: string,
    parts: CompletedPartInput[],
  ): Promise<Video> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.status !== VideoStatus.Draft) {
      throw new VideoInvalidStatusException(video.status);
    }
    const ordered = this.requireAllParts(video, parts);

    try {
      await this.storage.completeMultipartUpload(
        video.source_key,
        video.upload_id as string,
        ordered.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
      );
    } catch (error) {
      if (error instanceof MultipartUploadRejectedError) {
        throw new VideoUploadIncompleteException(error.message);
      }
      throw error;
    }

    const size = await this.storage.headObjectSize(video.source_key);
    if (size === null) {
      throw new VideoUploadIncompleteException('Uploaded object not found');
    }
    if (size > this.config.maxSizeBytes) {
      await this.storage.deleteObject(video.source_key);
      await this.videos.update(
        { id: video.id, status: VideoStatus.Draft },
        {
          status: VideoStatus.Failed,
          failure_reason: 'FILE_TOO_LARGE',
          upload_id: null,
        },
      );
      throw new VideoFileTooLargeException(this.config.maxSizeBytes);
    }

    const moved = await this.videos.update(
      { id: video.id, status: VideoStatus.Draft },
      { status: VideoStatus.Processing, size_bytes: size, upload_id: null },
    );
    if (!moved.affected) throw new VideoInvalidStatusException(video.status);

    try {
      await this.queue.enqueueProcessing(video.id);
    } catch (error) {
      await this.videos.update(
        { id: video.id, status: VideoStatus.Processing },
        { status: VideoStatus.Failed, failure_reason: 'QUEUE_UNAVAILABLE' },
      );
      throw error;
    }
    return { ...video, status: VideoStatus.Processing, size_bytes: size };
  }

  async abortUpload(userId: string, publicId: string): Promise<void> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.status !== VideoStatus.Draft) {
      throw new VideoInvalidStatusException(video.status);
    }
    await this.storage.abortMultipartUpload(
      video.source_key,
      video.upload_id as string,
    );
    await this.videos.delete({ id: video.id, status: VideoStatus.Draft });
  }

  // Also answers "not found" for another user's video so ids cannot be probed.
  async findOwnedByPublicId(userId: string, publicId: string): Promise<Video> {
    if (!isPublicId(publicId)) throw new VideoNotFoundException();
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new VideoNotFoundException();
    const video = await this.videos.findOne({
      where: { public_id: publicId, channel_id: channel.id },
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private async insertDraft(
    id: string,
    sourceKey: string,
    uploadId: string,
    channelId: string,
    input: InitUploadInput,
  ): Promise<Video> {
    for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt++) {
      try {
        return await this.videos.save(
          this.videos.create({
            id,
            public_id: generatePublicId(),
            channel_id: channelId,
            title: input.title ?? titleFromFilename(input.filename),
            status: VideoStatus.Draft,
            original_filename: input.filename,
            content_type: input.content_type,
            size_bytes: input.size_bytes,
            part_size_bytes: this.config.partSizeBytes,
            upload_id: uploadId,
            source_key: sourceKey,
          }),
        );
      } catch (error) {
        if (!isPublicIdCollision(error)) throw error;
      }
    }
    throw new Error(
      'Public id conflict could not be resolved after max retries',
    );
  }

  private requireAllParts(
    video: Video,
    parts: CompletedPartInput[],
  ): CompletedPartInput[] {
    const partCount = this.partCount(video);
    const ordered = [...parts].sort((a, b) => a.part_number - b.part_number);
    const complete =
      ordered.length === partCount &&
      ordered.every((part, index) => part.part_number === index + 1);
    if (!complete) {
      throw new VideoUploadIncompleteException(
        `Expected parts 1 to ${partCount}, each exactly once`,
      );
    }
    return ordered;
  }

  private partCount(video: Video): number {
    return Math.ceil(video.size_bytes / video.part_size_bytes);
  }

  private async presignParts(
    video: Video,
    partNumbers: number[],
  ): Promise<PartUrl[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storage.presignUploadPart(
          video.source_key,
          video.upload_id as string,
          partNumber,
          this.config.uploadUrlTtlSeconds,
        ),
      })),
    );
  }
}
