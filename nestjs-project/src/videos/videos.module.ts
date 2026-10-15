import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { VideoQueueModule } from './video-queue.module';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), VideoQueueModule],
  exports: [TypeOrmModule, VideoQueueModule],
})
export class VideosModule {}
