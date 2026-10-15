import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import {
  MultipartUploadRejectedError,
  StorageService,
} from './storage.service';

const MIB = 1024 * 1024;

// Real MinIO/ffmpeg calls: the 5 s default flakes when the host is busy.
jest.setTimeout(30_000);

describe('StorageService (integration, real MinIO)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const keysToClean: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await module.init();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await Promise.all(keysToClean.map((key) => storage.deleteObject(key)));
    await module.close();
  });

  const newKey = () => {
    const key = `integration/${randomUUID()}/source`;
    keysToClean.push(key);
    return key;
  };

  async function uploadPart(url: string, body: Buffer): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(200);
    return response.headers.get('etag') as string;
  }

  async function uploadTwoPartObject(key: string) {
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const first = Buffer.alloc(5 * MIB, 1);
    const second = Buffer.from('tail-of-the-object');
    const etag1 = await uploadPart(
      await storage.presignUploadPart(key, uploadId, 1, 600),
      first,
    );
    const etag2 = await uploadPart(
      await storage.presignUploadPart(key, uploadId, 2, 600),
      second,
    );
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag1 },
      { partNumber: 2, etag: etag2 },
    ]);
    return { first, second };
  }

  it('should bootstrap the bucket idempotently', async () => {
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
  });

  it('should assemble a 2-part upload sent straight to the presigned URLs', async () => {
    const key = newKey();

    const { first, second } = await uploadTwoPartObject(key);

    expect(await storage.headObjectSize(key)).toBe(
      first.length + second.length,
    );
  });

  it('should serve ranged reads of a presigned GET URL with 206', async () => {
    const key = newKey();
    await uploadTwoPartObject(key);

    const url = await storage.presignGet(key, { expiresIn: 600 });
    const response = await fetch(url, { headers: { Range: 'bytes=0-9' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect((await response.arrayBuffer()).byteLength).toBe(10);
  });

  it('should add an attachment Content-Disposition when a download name is given', async () => {
    const key = newKey();
    await uploadTwoPartObject(key);

    const url = await storage.presignGet(key, {
      expiresIn: 600,
      downloadFilename: 'my video.mp4',
    });
    const response = await fetch(url, { headers: { Range: 'bytes=0-9' } });

    expect(response.headers.get('content-disposition')).toContain(
      'attachment; filename="my video.mp4"',
    );
  });

  it('should reject a part upload after the multipart upload was aborted', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(key, uploadId, 1, 600);

    await storage.abortMultipartUpload(key, uploadId);

    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.from('late')),
    });
    expect(response.ok).toBe(false);
    await expect(
      storage.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
  });

  it('should map a rejected multipart completion to MultipartUploadRejectedError', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"does-not-exist"' },
      ]),
    ).rejects.toBeInstanceOf(MultipartUploadRejectedError);

    await storage.abortMultipartUpload(key, uploadId);
  });

  it('should put, presign through the internal client and delete an object', async () => {
    const key = newKey();
    await storage.putObject(key, Buffer.from('thumbnail-bytes'), 'image/jpeg');

    const url = await storage.presignGetInternal(key, 600);
    const response = await fetch(url);
    expect(await response.text()).toBe('thumbnail-bytes');

    await storage.deleteObject(key);
    expect(await storage.headObjectSize(key)).toBeNull();
  });
});
