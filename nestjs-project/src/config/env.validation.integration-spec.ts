import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 'access',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and video policy', () => {
  it('should reject a missing S3_ACCESS_KEY_ID', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, S3_ACCESS_KEY_ID: undefined },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY_ID');
  });

  it('should apply the storage, queue and upload policy defaults', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_BUCKET).toBe('streamtube-videos');
    expect(value.S3_FORCE_PATH_STYLE).toBe('true');
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.VIDEO_MAX_SIZE_BYTES).toBe(10737418240);
    expect(value.VIDEO_PART_SIZE_BYTES).toBe(104857600);
  });

  it('should reject a part size below the 5 MiB S3 minimum', () => {
    const { error } = validate({ VIDEO_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_PART_SIZE_BYTES');
  });
});
