// Runs after dotenv in every Jest process. Tests must never touch the development
// bucket or the queue consumed by the Compose video-worker, and presigned URLs
// must target the in-network storage host because tests run inside Docker.
process.env.S3_BUCKET = 'streamtube-test';
process.env.QUEUE_PREFIX = 'bull-test';
process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
