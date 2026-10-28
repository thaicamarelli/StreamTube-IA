import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
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

describe('envValidationSchema — storage and queue variables', () => {
  it('should apply storage defaults when not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://minio:9000');
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.STORAGE_ACCESS_KEY).toBe('streamtube');
    expect(value.STORAGE_SECRET_KEY).toBe('streamtube123');
    expect(value.STORAGE_VIDEOS_BUCKET).toBe('videos');
    expect(value.STORAGE_THUMBNAILS_BUCKET).toBe('thumbnails');
  });

  it('should apply queue defaults when not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.QUEUE_REDIS_HOST).toBe('redis');
    expect(value.QUEUE_REDIS_PORT).toBe(6379);
  });

  it('should reject a non-numeric QUEUE_REDIS_PORT', () => {
    const { error } = validate({ QUEUE_REDIS_PORT: 'not-a-number' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('QUEUE_REDIS_PORT');
  });

  it('should reject a non-URI STORAGE_ENDPOINT', () => {
    const { error } = validate({ STORAGE_ENDPOINT: 'not-a-url' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });

  it('should coerce string overrides for storage and queue variables', () => {
    const { value, error } = validate({
      STORAGE_ENDPOINT: 'http://custom-minio:9000',
      STORAGE_VIDEOS_BUCKET: 'custom-videos',
      QUEUE_REDIS_HOST: 'custom-redis',
      QUEUE_REDIS_PORT: '7000',
    });
    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://custom-minio:9000');
    expect(value.STORAGE_VIDEOS_BUCKET).toBe('custom-videos');
    expect(value.QUEUE_REDIS_HOST).toBe('custom-redis');
    expect(value.QUEUE_REDIS_PORT).toBe(7000);
  });
});
