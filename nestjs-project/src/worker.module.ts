import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from './auth/entities/refresh-token.entity';
import { VerificationToken } from './auth/entities/verification-token.entity';
import { Channel } from './channels/entities/channel.entity';
import { QueueModule } from './queue/queue.module';
import { appConfigModule, databaseModule } from './shared-modules';
import { User } from './users/entities/user.entity';
import { VideoProcessingModule } from './video-processing/video-processing.module';

// Entry module of the video-worker container: only the queue consumer, no HTTP.
@Module({
  imports: [
    appConfigModule,
    databaseModule,
    // Video relates to Channel and User; TypeORM needs the whole graph registered.
    TypeOrmModule.forFeature([User, Channel, RefreshToken, VerificationToken]),
    QueueModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
