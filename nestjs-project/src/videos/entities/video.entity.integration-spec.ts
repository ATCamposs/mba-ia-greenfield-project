import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from './video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `video_owner_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Owner Channel',
      nickname: `owner${counter}`,
      user_id: user.id,
    });
  });

  const buildVideo = (publicId: string): Partial<Video> => ({
    public_id: publicId,
    channel_id: channel.id,
    title: 'My video',
    original_filename: 'my-video.mp4',
    content_type: 'video/mp4',
    size_bytes: 10 * 1024 ** 3,
    part_size_bytes: 104857600,
    source_key: 'videos/some-id/source',
  });

  it('should default status to draft and leave processing results empty', async () => {
    const saved = await videoRepository.save(
      videoRepository.create(buildVideo('AAAAAAAAAAA')),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.Draft);
    expect(found.upload_id).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.failure_reason).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
  });

  it('should reject a duplicated public_id', async () => {
    await videoRepository.save(
      videoRepository.create(buildVideo('BBBBBBBBBBB')),
    );

    await expect(
      videoRepository.save(videoRepository.create(buildVideo('BBBBBBBBBBB'))),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('should read bigint size and numeric duration back as numbers', async () => {
    const saved = await videoRepository.save(
      videoRepository.create({
        ...buildVideo('CCCCCCCCCCC'),
        duration_seconds: 12.345,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(10 * 1024 ** 3);
    expect(found.duration_seconds).toBe(12.345);
  });

  it('should round-trip the metadata jsonb document', async () => {
    const metadata = {
      format: 'mov,mp4,m4a,3gp,3g2,mj2',
      bit_rate: 1234567,
      video: { codec: 'h264', width: 1280, height: 720, frame_rate: 25 },
      audio: null,
    };
    const saved = await videoRepository.save(
      videoRepository.create({ ...buildVideo('DDDDDDDDDDD'), metadata }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.metadata).toEqual(metadata);
  });

  it('should delete the videos of a deleted channel (cascade)', async () => {
    await videoRepository.save(
      videoRepository.create(buildVideo('EEEEEEEEEEE')),
    );

    await dataSource.getRepository(Channel).delete({ id: channel.id });

    expect(await videoRepository.count()).toBe(0);
  });

  it('should reject a video for a channel that does not exist', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          ...buildVideo('FFFFFFFFFFF'),
          channel_id: '00000000-0000-4000-8000-000000000000',
        }),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('should reject a status outside the lifecycle enum', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO videos (public_id, channel_id, title, status, original_filename, content_type, size_bytes, part_size_bytes, source_key)
         VALUES ('GGGGGGGGGGG', $1, 't', 'archived', 'f.mp4', 'video/mp4', 1, 5242880, 'k')`,
        [channel.id],
      ),
    ).rejects.toMatchObject({ code: '22P02' });
  });
});
