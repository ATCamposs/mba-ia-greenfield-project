import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { VideoQueueModule } from '../videos/video-queue.module';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

// Registered only by the worker process (and the e2e suite), never by AppModule.
@Module({
  imports: [TypeOrmModule.forFeature([Video]), StorageModule, VideoQueueModule],
  providers: [FfmpegService, VideoProcessingService, VideoProcessor],
})
export class VideoProcessingModule {}
