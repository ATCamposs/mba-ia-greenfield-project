---
libs:
  "bullmq":
    version: "^5.81.5"
    context7_id: "unavailable — context7 MCP was not connected in this session; official docs fetched from https://docs.bullmq.io"
    fetched_at: "2026-10-15T15:32:00-03:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "unavailable — official docs fetched from https://docs.nestjs.com/techniques/queues"
    fetched_at: "2026-10-15T15:32:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1152.0"
    context7_id: "unavailable — official docs fetched from https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html and the AWS SDK v3 API reference"
    fetched_at: "2026-10-15T15:32:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1152.0"
    context7_id: "unavailable — official docs fetched from https://github.com/aws/aws-sdk-js-v3/tree/main/packages/s3-request-presigner"
    fetched_at: "2026-10-15T15:32:00-03:00"
  "ffmpeg":
    version: "system package (Debian apt, installed in the image)"
    context7_id: "unavailable — official docs fetched from https://ffmpeg.org/ffprobe.html and https://ffmpeg.org/ffmpeg-protocols.html"
    fetched_at: "2026-10-15T15:32:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-15T15:34:02-03:00"
---

# Library references — phase-03-videos

> The project rule asks for `context7` lookups. The `context7` MCP server was not connected in the session that produced this phase, so every excerpt below was taken from the **official documentation pages** cited under each library (fetched 2026-10-15). Where a page did not state a detail, the entry says so instead of guessing; the integration tests are the backstop for those points.

### bullmq

Source: https://docs.bullmq.io (guides: retrying failing jobs, job ids, workers, going to production). Installed range `^5.81.5` (peer range of `@nestjs/bullmq@11.0.5` accepts `^3 || ^4 || ^5 || ^6`).

- **Retries:** `attempts` (must be > 1 to retry) and `backoff`; exponential delay is `2^(attempts - 1) * delay` ms; `jitter` (0–1) randomizes. Set per job (`queue.add(name, data, opts)`) or via `defaultJobOptions`.
- **Failure:** a processor that throws (must throw `Error`) or a stalled job beyond the max stalled count moves the job to the failed set after the last attempt; `removeOnFail` controls retention.
- **Idempotent add:** `jobId` is unique per queue; a second `add` with the same `jobId` is ignored while the first job still exists. `jobId` must not contain `:` and must not be only digits — use a prefix such as `video-<uuid>`.
- **Workers:** `new Worker(queueName, async (job) => ..., { connection, concurrency })`; events `completed(job, returnvalue)` and `failed(job, error)`. A worker must renew the job lock; CPU-blocking work may mark jobs stalled — child-process work (FFmpeg) does not block the event loop.
- **Production:** enable Redis AOF (`appendonly yes`) and set `maxmemory-policy noeviction` ("the only setting that guarantees the correct behavior of the queues"); `Queue` instances should disable `enableOfflineQueue` for fail-fast; `Worker` connections keep `maxRetriesPerRequest: null`; on `SIGINT`/`SIGTERM` call `worker.close()` before exiting.

### @nestjs/bullmq

Source: https://docs.nestjs.com/techniques/queues. Installed range `^11.0.5` (peer `@nestjs/core`/`@nestjs/common` `^10 || ^11`).

- Root config: `BullModule.forRoot({ connection: { host, port } , defaultJobOptions })` (use `forRootAsync` with `inject: [redisConfig.KEY]` to follow the project's `registerAs` pattern); `BullModule.registerQueue({ name })` per queue.
- Producer: `@InjectQueue(name) private readonly queue: Queue` then `queue.add(jobName, data, { jobId, attempts, backoff })`.
- Consumer: class decorated `@Processor(name)` extending `WorkerHost`, implementing `process(job)`; must be a provider. Worker events: `@OnWorkerEvent('failed')` etc. on methods of the processor class.
- The page's "separate process" option (`processors` file in a forked sandbox) removes DI; this project instead runs the whole processor in a **second container** from the same codebase (TD-04), which keeps DI.
- As with any `forRootAsync` + `ConfigType` usage, test modules need `ConfigModule.forRoot({ isGlobal: true, load: [...] })` (project testing rule).

### @aws-sdk/client-s3

Source: AWS S3 limits page https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html (multipart limits) and the SDK v3 command reference. Installed range `^3.1152.0` (Node >= 20).

- **Multipart limits:** part size 5 MiB–5 GiB (no minimum for the last part), 1–10,000 parts, max object 48.8 TiB; a single PUT is capped at 5 GiB, so a 10 GiB video needs multipart. `ListParts` returns at most 1000 parts per call.
- **Commands used:** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` (signed, executed by the client); `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })`; `AbortMultipartUploadCommand`; `ListPartsCommand` (verify parts on complete); `HeadObjectCommand` (size check); `GetObjectCommand` (presigned playback/download; `ResponseContentDisposition` for attachment); `PutObjectCommand` (thumbnail); `DeleteObjectCommand`.
- **Client config for S3-compatible servers:** `new S3Client({ region, endpoint, forcePathStyle: true, credentials, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' })` — the checksum settings stop the SDK from adding default checksum headers that presigned part uploads from a browser/curl would not send (to be confirmed by the e2e test; not stated on the fetched pages).
- The `ETag` returned by each part upload response is what the client sends back at completion; the storage CORS config must expose it (`ExposeHeaders: ETag`; MinIO: `MINIO_API_CORS_ALLOW_ORIGIN`).

### @aws-sdk/s3-request-presigner

Source: https://github.com/aws/aws-sdk-js-v3/tree/main/packages/s3-request-presigner. Installed range `^3.1152.0`.

- `getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn })` — `expiresIn` in seconds (default 900).
- Headers outside `x-amz-*` that must be enforced are added with `signableHeaders` (e.g. `content-type`); `x-amz-*` headers that must be sent by the uploader are `unhoistableHeaders`; `hoistableHeaders` overrides the default of not hoisting.
- The **host is part of the signature**: sign with a client configured with the endpoint the caller will use (`S3_PUBLIC_ENDPOINT`), not the Docker-internal one (TD-03/TD-11). The page shows no `UploadPart` example; the same `getSignedUrl(client, new UploadPartCommand({...}))` call pattern applies and is verified by the e2e test.

### ffmpeg

Source: https://ffmpeg.org/ffprobe.html and https://ffmpeg.org/ffmpeg-protocols.html#http. Installed from the Debian package in `Dockerfile.dev` (`apt install ffmpeg`), invoked with `child_process.spawn` and an **argument array** (never a shell string).

- **Metadata:** `ffprobe -v error -print_format json -show_format -show_streams <input>` → JSON with `format` (`duration`, `size`, `bit_rate`, `format_name`) and `streams[]` (`codec_type`, `codec_name`, `width`, `height`, `r_frame_rate`, `channels`, `sample_rate`). `-show_entries` limits fields.
- **Thumbnail:** `ffmpeg -ss <seconds> -i <input> -frames:v 1 -vf scale='min(1280,iw)':-2 -y <out.jpg>` — placing `-ss` before `-i` seeks the input (fast with range requests).
- **HTTP input (presigned GET URL):** the http protocol auto-detects seekability (`seekable` default −1) and uses range requests; useful options: `reconnect`, `reconnect_streamed`, `reconnect_delay_max`, `reconnect_max_retries`, `multiple_requests`, `rw_timeout` (microseconds, generic option) — to be passed before `-i` as input options. The pages did not document an exact timeout recipe for 10 GiB inputs; the worker enforces its own process timeout and the BullMQ job retries on failure.
