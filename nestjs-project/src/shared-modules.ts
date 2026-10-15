import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from './config/app.config';
import authConfig from './config/auth.config';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import mailConfig from './config/mail.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import swaggerConfig from './config/swagger.config';
import videosConfig from './config/videos.config';

// Shared by the API (AppModule) and the video worker (WorkerModule) so both
// processes validate the same environment and open the same database connection.
export const appConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  load: [
    appConfig,
    authConfig,
    databaseConfig,
    mailConfig,
    queueConfig,
    storageConfig,
    swaggerConfig,
    videosConfig,
  ],
  validationSchema: envValidationSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
});

export const databaseModule = TypeOrmModule.forRootAsync({
  imports: [ConfigModule],
  inject: [databaseConfig.KEY],
  useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    autoLoadEntities: true,
    synchronize: false,
  }),
});
