import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { QueueModule } from './queue/queue.module';
import { appConfigModule, databaseModule } from './shared-modules';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [
    appConfigModule,
    databaseModule,
    QueueModule,
    AuthModule,
    VideosModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
