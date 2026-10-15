import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export class MultipartUploadRejectedError extends Error {
  constructor(public readonly code: string) {
    super(`The storage rejected the multipart upload: ${code}`);
  }
}

const REJECTED_UPLOAD_CODES = [
  'InvalidPart',
  'InvalidPartOrder',
  'NoSuchUpload',
  'EntityTooSmall',
];

interface AwsError {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

const isNotFound = (error: unknown): boolean => {
  const { name, $metadata } = (error ?? {}) as AwsError;
  return (
    name === 'NotFound' ||
    name === 'NoSuchKey' ||
    name === 'NoSuchBucket' ||
    $metadata?.httpStatusCode === 404
  );
};

// ASCII fallback plus RFC 5987 form so non-ASCII file names survive.
const contentDisposition = (filename: string): string => {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\;]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);
  // Server-side calls use the in-network endpoint; presigned URLs must be signed
  // with the host the caller will reach, because the host is part of the signature.
  private readonly internalClient: S3Client;
  private readonly presignClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.internalClient = this.buildClient(config.endpoint);
    this.presignClient = this.buildClient(config.publicEndpoint);
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.presignClient.destroy();
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.internalClient.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.internalClient.send(
        new CreateBucketCommand({ Bucket: this.bucket }),
      );
    }

    try {
      await this.internalClient.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'abort-incomplete-multipart-uploads',
                Status: 'Enabled',
                Filter: { Prefix: '' },
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
              },
            ],
          },
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Storage rejected the multipart cleanup lifecycle rule (relying on its own stale-upload cleanup): ${(error as Error).message}`,
      );
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    return UploadId as string;
  }

  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      const { name } = (error ?? {}) as AwsError;
      if (name && REJECTED_UPLOAD_CODES.includes(name)) {
        throw new MultipartUploadRejectedError(name);
      }
      throw error;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if ((error as AwsError | undefined)?.name !== 'NoSuchUpload') throw error;
    }
  }

  // Resolves to null when the object does not exist.
  async headObjectSize(key: string): Promise<number | null> {
    try {
      const { ContentLength } = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return ContentLength ?? 0;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  presignGet(
    key: string,
    options: { expiresIn: number; downloadFilename?: string },
  ): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.downloadFilename && {
          ResponseContentDisposition: contentDisposition(
            options.downloadFilename,
          ),
        }),
      }),
      { expiresIn: options.expiresIn },
    );
  }

  // For the worker, which reads the source over the Docker network.
  presignGetInternal(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn },
    );
  }

  private buildClient(endpoint: string): S3Client {
    return new S3Client({
      region: this.config.region,
      endpoint,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
}
