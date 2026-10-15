import {
  InvalidMediaError,
  parseProbe,
  thumbnailSeekSeconds,
} from './probe-result';

const videoStream = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 1280,
  height: 720,
  r_frame_rate: '30000/1001',
};
const audioStream = {
  codec_type: 'audio',
  codec_name: 'aac',
  channels: 2,
  sample_rate: '44100',
};
const format = {
  duration: '12.345000',
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  bit_rate: '1500000',
};

describe('parseProbe', () => {
  it('extracts duration, container, bit rate, video and audio streams', () => {
    const { durationSeconds, metadata } = parseProbe({
      format,
      streams: [videoStream, audioStream],
    });

    expect(durationSeconds).toBe(12.345);
    expect(metadata).toEqual({
      format: 'mov,mp4,m4a,3gp,3g2,mj2',
      bit_rate: 1500000,
      video: { codec: 'h264', width: 1280, height: 720, frame_rate: 29.97 },
      audio: { codec: 'aac', channels: 2, sample_rate: 44100 },
    });
  });

  it('reports no audio for a silent video and an unknown frame rate as null', () => {
    const { metadata } = parseProbe({
      format,
      streams: [{ ...videoStream, r_frame_rate: '0/0' }],
    });

    expect(metadata.audio).toBeNull();
    expect(metadata.video?.frame_rate).toBeNull();
  });

  it('rejects media without a video stream, including audio with cover art', () => {
    expect(() => parseProbe({ format, streams: [audioStream] })).toThrow(
      InvalidMediaError,
    );
    expect(() =>
      parseProbe({
        format,
        streams: [
          { ...videoStream, disposition: { attached_pic: 1 } },
          audioStream,
        ],
      }),
    ).toThrow(InvalidMediaError);
  });

  it('rejects media without a positive duration', () => {
    expect(() =>
      parseProbe({
        format: { ...format, duration: undefined },
        streams: [videoStream],
      }),
    ).toThrow(InvalidMediaError);
    expect(() =>
      parseProbe({
        format: { ...format, duration: '0.000000' },
        streams: [videoStream],
      }),
    ).toThrow(InvalidMediaError);
    expect(() => parseProbe({})).toThrow(InvalidMediaError);
  });
});

describe('thumbnailSeekSeconds', () => {
  it.each([
    [0.5, 0],
    [1.99, 0],
    [2, 1],
    [5, 1],
    [30, 3],
    [3600, 360],
  ])('seeks %p seconds videos to %p', (duration, expected) => {
    expect(thumbnailSeekSeconds(duration)).toBe(expected);
  });
});
