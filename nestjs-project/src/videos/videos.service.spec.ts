import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
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
import { VideoQueueService } from './video-queue.service';
import { VideosService } from './videos.service';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const config = {
  maxSizeBytes: 10 * GIB,
  partSizeBytes: 100 * MIB,
  uploadUrlTtlSeconds: 21600,
  playbackUrlTtlSeconds: 21600,
};

const duplicatePublicId = () =>
  new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (public_id)=(AAAAAAAAAAA) already exists.',
    }),
  );

describe('VideosService (unit)', () => {
  let service: VideosService;
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let queue: { enqueueProcessing: jest.Mock };
  let channels: { findByUserId: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    presignGet: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObjectSize: jest.Mock;
    deleteObject: jest.Mock;
  };

  beforeEach(() => {
    repository = {
      create: jest.fn((entity: Partial<Video>) => entity),
      save: jest.fn((entity: Partial<Video>) => Promise.resolve(entity)),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    queue = { enqueueProcessing: jest.fn().mockResolvedValue(undefined) };
    channels = {
      findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      presignGet: jest.fn().mockResolvedValue('https://storage/get'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObjectSize: jest.fn().mockResolvedValue(250 * MIB),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      presignUploadPart: jest
        .fn()
        .mockImplementation((_k, _u, partNumber: number) =>
          Promise.resolve(`https://storage/part-${partNumber}`),
        ),
    };
    service = new VideosService(
      repository as unknown as Repository<Video>,
      channels as unknown as ChannelsService,
      storage as unknown as StorageService,
      queue as unknown as VideoQueueService,
      config,
    );
  });

  describe('initUpload', () => {
    const input = {
      filename: 'Holiday.2024.mp4',
      content_type: 'video/mp4',
      size_bytes: 250 * MIB,
    };

    it('rejects a user without a channel', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(service.initUpload('user-1', input)).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
    });

    it('rejects a file above the maximum size without touching the storage', async () => {
      await expect(
        service.initUpload('user-1', { ...input, size_bytes: 10 * GIB + 1 }),
      ).rejects.toBeInstanceOf(VideoFileTooLargeException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('rejects a content type outside the allowed list', async () => {
      await expect(
        service.initUpload('user-1', {
          ...input,
          content_type: 'application/pdf',
        }),
      ).rejects.toBeInstanceOf(UnsupportedVideoTypeException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('creates the draft with a title derived from the file name and the part plan', async () => {
      const plan = await service.initUpload('user-1', input);

      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/[0-9a-f-]{36}\/source$/),
        'video/mp4',
      );
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-1',
          title: 'Holiday.2024',
          status: VideoStatus.Draft,
          part_size_bytes: 100 * MIB,
          upload_id: 'upload-1',
        }),
      );
      expect(plan.part_count).toBe(3);
      expect(plan.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
      expect(plan.expires_in_seconds).toBe(21600);
    });

    it('keeps an explicit title and trims a long derived title to 100 characters', async () => {
      await service.initUpload('user-1', { ...input, title: 'Custom' });
      expect(repository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: 'Custom' }),
      );

      await service.initUpload('user-1', {
        ...input,
        filename: `${'a'.repeat(150)}.mp4`,
      });
      expect(repository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: 'a'.repeat(100) }),
      );
    });

    it('plans 103 parts for a file of exactly 10 GiB', async () => {
      const plan = await service.initUpload('user-1', {
        ...input,
        size_bytes: 10 * GIB,
      });

      expect(plan.part_count).toBe(103);
      expect(plan.parts).toHaveLength(103);
    });

    it('retries with a new public id after a public_id collision', async () => {
      repository.save
        .mockRejectedValueOnce(duplicatePublicId())
        .mockImplementation((entity: Partial<Video>) =>
          Promise.resolve(entity),
        );

      await service.initUpload('user-1', input);

      expect(repository.save).toHaveBeenCalledTimes(2);
      const ids = repository.save.mock.calls.map(
        (c) => (c[0] as Video).public_id,
      );
      expect(ids[0]).not.toBe(ids[1]);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('aborts the multipart upload when the draft cannot be saved', async () => {
      repository.save.mockRejectedValue(new Error('db down'));

      await expect(service.initUpload('user-1', input)).rejects.toThrow(
        'db down',
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\//),
        'upload-1',
      );
    });
  });

  describe('findOwnedByPublicId', () => {
    it('rejects a malformed public id without querying', async () => {
      await expect(
        service.findOwnedByPublicId('user-1', '../etc'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(repository.findOne).not.toHaveBeenCalled();
    });

    it('rejects a user without a channel and a video that is not found', async () => {
      channels.findByUserId.mockResolvedValue(null);
      await expect(
        service.findOwnedByPublicId('user-1', 'AAAAAAAAAAA'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      channels.findByUserId.mockResolvedValue({ id: 'channel-1' });
      repository.findOne.mockResolvedValue(null);
      await expect(
        service.findOwnedByPublicId('user-1', 'AAAAAAAAAAA'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('looks the video up by public id within the caller channel', async () => {
      const video = { id: 'v1' } as Video;
      repository.findOne.mockResolvedValue(video);

      await expect(
        service.findOwnedByPublicId('user-1', 'AAAAAAAAAAA'),
      ).resolves.toBe(video);
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { public_id: 'AAAAAAAAAAA', channel_id: 'channel-1' },
      });
    });
  });

  describe('refreshPartUrls', () => {
    const draft = {
      status: VideoStatus.Draft,
      size_bytes: 250 * MIB,
      part_size_bytes: 100 * MIB,
      source_key: 'videos/v1/source',
      upload_id: 'upload-1',
    } as Video;

    it('rejects a video that is no longer a draft', async () => {
      repository.findOne.mockResolvedValue({
        ...draft,
        status: VideoStatus.Processing,
      } as Video);

      await expect(
        service.refreshPartUrls('user-1', 'AAAAAAAAAAA', [1]),
      ).rejects.toBeInstanceOf(VideoInvalidStatusException);
    });

    it('rejects part numbers outside 1..part_count', async () => {
      repository.findOne.mockResolvedValue(draft);

      await expect(
        service.refreshPartUrls('user-1', 'AAAAAAAAAAA', [1, 4]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      await expect(
        service.refreshPartUrls('user-1', 'AAAAAAAAAAA', [0]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
    });

    it('returns fresh URLs for the requested parts only', async () => {
      repository.findOne.mockResolvedValue(draft);

      const result = await service.refreshPartUrls(
        'user-1',
        'AAAAAAAAAAA',
        [2, 3],
      );

      expect(result.parts.map((p) => p.part_number)).toEqual([2, 3]);
      expect(storage.presignUploadPart).toHaveBeenCalledTimes(2);
    });
  });

  describe('completeUpload', () => {
    const draft = {
      id: 'v1',
      status: VideoStatus.Draft,
      size_bytes: 250 * MIB,
      part_size_bytes: 100 * MIB,
      source_key: 'videos/v1/source',
      upload_id: 'upload-1',
    } as Video;
    const allParts = [
      { part_number: 3, etag: 'c' },
      { part_number: 1, etag: 'a' },
      { part_number: 2, etag: 'b' },
    ];

    beforeEach(() => repository.findOne.mockResolvedValue(draft));

    it('rejects a video that is not a draft without touching the storage', async () => {
      repository.findOne.mockResolvedValue({
        ...draft,
        status: VideoStatus.Processing,
      });

      await expect(
        service.completeUpload('user-1', 'AAAAAAAAAAA', allParts),
      ).rejects.toBeInstanceOf(VideoInvalidStatusException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.enqueueProcessing).not.toHaveBeenCalled();
    });

    it.each([
      ['a missing part', [{ part_number: 1, etag: 'a' }]],
      [
        'a duplicated part',
        [
          { part_number: 1, etag: 'a' },
          { part_number: 1, etag: 'a' },
          { part_number: 2, etag: 'b' },
        ],
      ],
      [
        'a misnumbered part',
        [
          { part_number: 1, etag: 'a' },
          { part_number: 2, etag: 'b' },
          { part_number: 4, etag: 'd' },
        ],
      ],
    ])('rejects %s', async (_label, parts) => {
      await expect(
        service.completeUpload('user-1', 'AAAAAAAAAAA', parts),
      ).rejects.toBeInstanceOf(VideoUploadIncompleteException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('maps a storage rejection to an incomplete upload', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new MultipartUploadRejectedError('InvalidPart'),
      );

      await expect(
        service.completeUpload('user-1', 'AAAAAAAAAAA', allParts),
      ).rejects.toBeInstanceOf(VideoUploadIncompleteException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('completes with the parts in order, stores the real size and enqueues once', async () => {
      const result = await service.completeUpload(
        'user-1',
        'AAAAAAAAAAA',
        allParts,
      );

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/v1/source',
        'upload-1',
        [
          { partNumber: 1, etag: 'a' },
          { partNumber: 2, etag: 'b' },
          { partNumber: 3, etag: 'c' },
        ],
      );
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'v1', status: VideoStatus.Draft },
        {
          status: VideoStatus.Processing,
          size_bytes: 250 * MIB,
          upload_id: null,
        },
      );
      expect(queue.enqueueProcessing).toHaveBeenCalledTimes(1);
      expect(queue.enqueueProcessing).toHaveBeenCalledWith('v1');
      expect(result.status).toBe(VideoStatus.Processing);
    });

    it('deletes an object above the maximum size and fails the video', async () => {
      storage.headObjectSize.mockResolvedValue(10 * GIB + 1);

      await expect(
        service.completeUpload('user-1', 'AAAAAAAAAAA', allParts),
      ).rejects.toBeInstanceOf(VideoFileTooLargeException);
      expect(storage.deleteObject).toHaveBeenCalledWith('videos/v1/source');
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'v1', status: VideoStatus.Draft },
        expect.objectContaining({
          status: VideoStatus.Failed,
          failure_reason: 'FILE_TOO_LARGE',
        }),
      );
      expect(queue.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('does not enqueue when a concurrent request already moved the video', async () => {
      repository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.completeUpload('user-1', 'AAAAAAAAAAA', allParts),
      ).rejects.toBeInstanceOf(VideoInvalidStatusException);
      expect(queue.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('marks the video failed when the queue is unavailable', async () => {
      queue.enqueueProcessing.mockRejectedValue(new Error('redis down'));

      await expect(
        service.completeUpload('user-1', 'AAAAAAAAAAA', allParts),
      ).rejects.toThrow('redis down');
      expect(repository.update).toHaveBeenLastCalledWith(
        { id: 'v1', status: VideoStatus.Processing },
        { status: VideoStatus.Failed, failure_reason: 'QUEUE_UNAVAILABLE' },
      );
    });
  });

  describe('abortUpload', () => {
    it('aborts the multipart upload and deletes the draft', async () => {
      repository.findOne.mockResolvedValue({
        id: 'v1',
        status: VideoStatus.Draft,
        source_key: 'videos/v1/source',
        upload_id: 'upload-1',
      });

      await service.abortUpload('user-1', 'AAAAAAAAAAA');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/v1/source',
        'upload-1',
      );
      expect(repository.delete).toHaveBeenCalledWith({
        id: 'v1',
        status: VideoStatus.Draft,
      });
    });

    it('rejects a video that is not a draft', async () => {
      repository.findOne.mockResolvedValue({
        id: 'v1',
        status: VideoStatus.Ready,
      });

      await expect(
        service.abortUpload('user-1', 'AAAAAAAAAAA'),
      ).rejects.toBeInstanceOf(VideoInvalidStatusException);
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });

  describe('public playback lookups', () => {
    const ready = {
      id: 'v1',
      status: VideoStatus.Ready,
      source_key: 'videos/v1/source',
      thumbnail_key: 'videos/v1/thumbnail.jpg',
      original_filename: 'my clip.mp4',
    } as Video;

    it('only looks up ready videos and answers 404 for anything else', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.getReadyVideo('AAAAAAAAAAA')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { public_id: 'AAAAAAAAAAA', status: VideoStatus.Ready },
      });
      await expect(service.getReadyVideo('bad')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('presigns the source inline for streaming and as attachment for download', async () => {
      repository.findOne.mockResolvedValue(ready);

      await service.getStreamUrl('AAAAAAAAAAA');
      await service.getDownloadUrl('AAAAAAAAAAA');

      expect(storage.presignGet).toHaveBeenNthCalledWith(
        1,
        'videos/v1/source',
        {
          expiresIn: 21600,
        },
      );
      expect(storage.presignGet).toHaveBeenNthCalledWith(
        2,
        'videos/v1/source',
        {
          expiresIn: 21600,
          downloadFilename: 'my clip.mp4',
        },
      );
    });

    it('presigns the thumbnail and rejects a ready video without one', async () => {
      repository.findOne.mockResolvedValue(ready);
      await service.getThumbnailUrl('AAAAAAAAAAA');
      expect(storage.presignGet).toHaveBeenCalledWith(
        'videos/v1/thumbnail.jpg',
        { expiresIn: 21600 },
      );

      repository.findOne.mockResolvedValue({ ...ready, thumbnail_key: null });
      await expect(
        service.getThumbnailUrl('AAAAAAAAAAA'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
