import {
  INestApplication,
  ModuleMetadata,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { MailService } from '../../src/mail/mail.service';

export interface VideoTestApp {
  app: INestApplication<App>;
  clearThrottle: () => void;
}

// Mirrors main.ts: Test.createTestingModule does not run bootstrap().
export async function createVideoTestApp(
  extraImports: ModuleMetadata['imports'] = [],
): Promise<VideoTestApp> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule, ...extraImports],
  }).compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  const throttlerStorage =
    moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  return { app, clearThrottle: () => throttlerStorage.storage.clear() };
}

export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  let token = '';
  jest
    .spyOn(app.get(MailService, { strict: false }), 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, raw: string) => {
      token = raw;
      return Promise.resolve();
    });
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  return login.body.access_token as string;
}

export interface PartPlan {
  parts: { part_number: number; url: string }[];
  part_size_bytes: number;
}

// Sends every part straight to the storage, like a browser would.
export async function uploadParts(
  plan: PartPlan,
  content: Buffer,
): Promise<{ part_number: number; etag: string }[]> {
  const uploaded: { part_number: number; etag: string }[] = [];
  for (const part of plan.parts) {
    const start = (part.part_number - 1) * plan.part_size_bytes;
    const body = content.subarray(start, start + plan.part_size_bytes);
    const response = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    if (response.status !== 200) {
      throw new Error(
        `Part ${part.part_number} upload failed: ${response.status}`,
      );
    }
    uploaded.push({
      part_number: part.part_number,
      etag: response.headers.get('etag') as string,
    });
  }
  return uploaded;
}
