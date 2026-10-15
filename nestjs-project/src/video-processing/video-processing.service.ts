import { readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { thumbnailSeekSeconds } from './probe-result';

export type FailureReason =
  | 'INVALID_MEDIA'
  | 'SOURCE_MISSING'
  | 'PROCESSING_FAILED';

export class SourceMissingError extends Error {
  constructor(key: string) {
    super(`Source object ${key} does not exist`);
    this.name = 'SourceMissingError';
  }
}

@Injectable()
export class VideoProcessingService {
  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  // Replays are safe: anything but a `processing` video is left untouched.
  async process(videoId: string): Promise<void> {
    const video = await this.videos.findOne({ where: { id: videoId } });
    if (!video || video.status !== VideoStatus.Processing) return;

    if ((await this.storage.headObjectSize(video.source_key)) === null) {
      throw new SourceMissingError(video.source_key);
    }

    // The worker reads the source over the Docker network; no local copy of the video.
    const sourceUrl = await this.storage.presignGetInternal(
      video.source_key,
      this.config.playbackUrlTtlSeconds,
    );
    const probed = await this.ffmpeg.probe(sourceUrl);

    const thumbnailPath = join(tmpdir(), `thumbnail-${video.id}.jpg`);
    try {
      await this.ffmpeg.extractThumbnail(
        sourceUrl,
        thumbnailSeekSeconds(probed.durationSeconds),
        thumbnailPath,
      );
      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      await this.storage.putObject(
        thumbnailKey,
        await readFile(thumbnailPath),
        'image/jpeg',
      );
      await this.videos.update(
        { id: video.id, status: VideoStatus.Processing },
        {
          status: VideoStatus.Ready,
          duration_seconds: probed.durationSeconds,
          metadata: probed.metadata,
          thumbnail_key: thumbnailKey,
        },
      );
    } finally {
      await rm(thumbnailPath, { force: true });
    }
  }

  async markFailed(videoId: string, reason: FailureReason): Promise<void> {
    await this.videos.update(
      { id: videoId, status: VideoStatus.Processing },
      { status: VideoStatus.Failed, failure_reason: reason },
    );
  }
}
