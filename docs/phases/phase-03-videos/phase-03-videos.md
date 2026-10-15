---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-15T15:34:02-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-15T15:34:02-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-15T15:34:02-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-15T15:12:21-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver direct-to-storage upload of videos up to 10GB (S3 multipart with presigned parts — the API never carries the file bytes), automatic draft pre-registration, background processing in a queue-driven worker (duration, metadata and thumbnail extraction with FFmpeg), a unique public URL per video, and streaming and download of ready videos — all running on real MinIO, Redis and worker containers in Docker Compose.

---

## Step Implementations

### SI-03.1 — Dependencies, Test Script and Image Tooling

**Description:** Install the queue and storage libraries, make `npm test` run serially (the DB-backed suites share one database), fix the `.env.example` line that Docker Compose cannot parse, and bake FFmpeg into the development image.

**Technical actions:**

1. Install production dependencies in `nestjs-project`: `bullmq@^5.81.5`, `@nestjs/bullmq@^11.0.5`, `@aws-sdk/client-s3@^3.1152.0`, `@aws-sdk/s3-request-presigner@^3.1152.0` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
2. Change the `test` script in `package.json` to `jest --runInBand` so unit and integration suites never run in parallel workers (per `phase-03-videos/TD-10`)
3. Quote the whole `MAIL_FROM` value in `.env.example` so Docker Compose and `dotenv` both parse it (per `phase-03-videos/TD-11`)
4. Add `ffmpeg` to the `apt install` line of `Dockerfile.dev` (provides the `ffmpeg` and `ffprobe` binaries) (per `phase-03-videos/TD-04`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` parses `.env` copied from `.env.example` without a `MAIL_FROM` parsing error
- `ffmpeg -version` and `ffprobe -version` succeed inside the `nestjs-api` container after rebuilding the image
- `npm test` executes the existing suites serially and finishes green on a clean database

---

### SI-03.2 — MinIO and Redis in Docker Compose

**Description:** Add the real object storage and the real queue backend to Compose so the API, the worker and the tests all talk to real services.

**Technical actions:**

1. Add a `minio` service to `compose.yaml` using the pinned image `bitnamilegacy/minio:2025.7.23-debian-12-r5`, S3 API on `9000`, console on `9001`, credentials taken from `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, a named volume for data, `MINIO_API_CORS_ALLOW_ORIGIN` set so browsers may upload parts and read the `ETag` header, and a healthcheck on `/minio/health/live` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-02`)
2. Add a `redis` service using `redis:7-alpine` started with `--appendonly yes --maxmemory-policy noeviction`, a named volume and a `redis-cli ping` healthcheck (per `phase-03-videos/TD-11`, `phase-03-videos/TD-01`)
3. Make `nestjs-api` depend on `minio` and `redis` with `condition: service_healthy`
4. Declare the `minio-data` and `redis-data` volumes in `compose.yaml`

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `docker compose ps` shows `minio` and `redis` as `healthy`
- `GET http://localhost:9000/minio/health/live` returns `200`
- `redis-cli ping` inside the `redis` container returns `PONG`
- The MinIO console answers on `http://localhost:9001`

---

### SI-03.3 — Storage, Queue and Video Configuration Namespaces

**Description:** Add the `storage`, `queue` and `videos` config namespaces following the `registerAs` pattern, validate the new environment variables with Joi and document them in `.env.example`.

**Technical actions:**

1. Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `S3_ENDPOINT` (default `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (default `http://localhost:9000`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` (default `streamtube-videos`), `S3_FORCE_PATH_STYLE` (boolean, default `true`) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-11`)
2. Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (default `redis`) and `REDIS_PORT` (number, default `6379`) (per `phase-03-videos/TD-11`)
3. Create `src/config/videos.config.ts` — `registerAs('videos', ...)` reading `VIDEO_MAX_SIZE_BYTES` (default `10737418240`), `VIDEO_PART_SIZE_BYTES` (default `104857600`), `VIDEO_UPLOAD_URL_TTL_SECONDS` (default `21600`), `VIDEO_PLAYBACK_URL_TTL_SECONDS` (default `21600`) (per `phase-03-videos/TD-09`)
4. Extend `src/config/env.validation.ts` with every new variable (`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` required, the rest with the defaults above; `VIDEO_PART_SIZE_BYTES` minimum `5242880` — the S3 part-size floor) and register the three namespaces in the `load` array of `ConfigModule.forRoot` in `src/app.module.ts`
5. Add all new keys with Compose-compatible development values to `.env.example` (per `phase-03-videos/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (new keys) | Integration: missing `S3_ACCESS_KEY_ID` fails validation, defaults applied, `VIDEO_PART_SIZE_BYTES` below 5 MiB rejected | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Starting the application without `S3_ACCESS_KEY_ID` causes a Joi validation error at bootstrap — the app does not start
- Starting the application with `VIDEO_PART_SIZE_BYTES=1048576` causes a Joi validation error — the app does not start
- With only the required variables set, the resolved configuration exposes `videos.maxSizeBytes = 10737418240` and `videos.partSizeBytes = 104857600`
- The application starts with the values from `.env.example`

---

### SI-03.4 — Video Entity, Migration and Test Cleanup

**Description:** Create the `Video` entity and its module skeleton, generate the `videos` table migration with the TypeORM CLI and make the shared test helper wipe the new table.

**Technical actions:**

1. Create `src/videos/entities/video.entity.ts` — `Video` mapped to `videos` with the columns, relation and indexes of `### Data Model → Video`, and the `VideoStatus` enum (`draft`, `processing`, `ready`, `failed`) exported from `src/videos/entities/video-status.enum.ts` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-07`)
2. Create `src/videos/videos.module.ts` registering `TypeOrmModule.forFeature([Video])` and import `VideosModule` in `AppModule`
3. Generate the migration with `npm run migration:generate -- src/database/migrations/CreateVideosTable` (never hand-written) and run it with `npm run migration:run`
4. Add `videos` to the table list of `cleanAllTables` in `src/test/create-test-data-source.ts` and register `Video` in the helper's entity list

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique `public_id`, FK to `channels` with cascade delete, `status` default `draft`, `metadata` jsonb round-trip, `size_bytes` bigint read back as number | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Unit: module compiles with `TypeOrmModule.forFeature([Video])` | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3

**Acceptance criteria:**

- After `npm run migration:run`, the `videos` table exists with a unique index on `public_id` and a foreign key to `channels(id)` with `ON DELETE CASCADE`
- Inserting two videos with the same `public_id` fails with a unique violation
- Deleting a channel removes its videos
- A video inserted with only the required columns has `status = 'draft'`
- `npm run migration:revert` drops the `videos` table and the status enum cleanly

---

### SI-03.5 — Storage Service (S3-compatible)

**Description:** Wrap the S3 SDK in a `StorageService` that owns bucket bootstrap, multipart upload orchestration, presigning and object operations, using one internal client and one public-endpoint presigning client.

**Technical actions:**

1. Create `src/storage/storage.module.ts` exporting `StorageService`, and `src/storage/storage.service.ts` building two `S3Client`s from the `storage` namespace — internal (`S3_ENDPOINT`) and presigning (`S3_PUBLIC_ENDPOINT`) — both with `forcePathStyle`, `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-03`)
2. Implement the multipart operations on the internal client: `createMultipartUpload(key, contentType)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, plus `presignUploadPart(key, uploadId, partNumber, expiresIn)` signed with the public client (per `phase-03-videos/TD-02`)
3. Implement object operations: `headObjectSize(key)`, `putObject(key, body, contentType)`, `deleteObject(key)`, `presignGet(key, { expiresIn, downloadFilename? })` signed with the public client (`ResponseContentDisposition: attachment` when `downloadFilename` is given), and `presignGetInternal(key, expiresIn)` signed with the internal client for the worker (per `phase-03-videos/TD-06`, `phase-03-videos/TD-04`)
4. Implement `onModuleInit` bucket bootstrap: create the bucket when it does not exist and apply a lifecycle rule that aborts incomplete multipart uploads after 1 day, logging a warning (not failing) if the storage rejects the lifecycle call (per `phase-03-videos/TD-09`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (real MinIO): bucket bootstrap is idempotent; 2-part multipart upload through presigned part URLs + complete + `headObjectSize`; presigned GET honours `Range` with `206`; `downloadFilename` yields `Content-Disposition: attachment`; abort invalidates the upload; `deleteObject` removes the object | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: module compiles with the `storage` config namespace | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- A 2-part upload (parts uploaded with plain `fetch` `PUT` to the presigned URLs) followed by `completeMultipartUpload` produces an object whose size equals the sum of the parts
- A presigned GET URL for that object returns `206` with the requested slice for a `Range: bytes=0-9` request
- A presigned GET URL generated with `downloadFilename` returns `Content-Disposition: attachment; filename="<name>"`
- A part URL for an aborted upload is rejected by the storage
- Starting the service twice against the same bucket does not fail

---

### SI-03.6 — Video Domain Exceptions and Public Identifier

**Description:** Add the video error vocabulary to the domain exception hierarchy and the generator for the 11-character public identifier used in video URLs.

**Technical actions:**

1. Add `VideoNotFoundException`, `VideoInvalidStatusException`, `VideoFileTooLargeException`, `UnsupportedVideoTypeException`, `VideoUploadIncompleteException`, `InvalidPartNumberException` and `ChannelNotFoundException` to `src/common/exceptions/domain.exception.ts`, with the `errorCode` and `httpStatus` of `### Error Catalog` (per `phase-02-auth/TD-07`)
2. Create `src/videos/public-id.util.ts` — `generatePublicId()` returning 8 random bytes (`crypto.randomBytes`) encoded as base64url (11 characters), and `isPublicId(value)` matching `^[A-Za-z0-9_-]{11}$` (per `phase-03-videos/TD-05`)
3. Create `src/videos/video-content-types.ts` exporting the allowed declared content types `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska` (per `phase-03-videos/TD-09`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generatePublicId`, `isPublicId` | Unit: length 11, URL-safe alphabet, no collisions across 10,000 generated ids, validator rejects malformed values | `src/videos/public-id.util.spec.ts` |
| `DomainExceptionFilter` (video exceptions) | Unit: each new exception maps to its `{ statusCode, error, message }` | `src/common/filters/domain-exception.filter.spec.ts` |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- A service throwing `VideoNotFoundException` results in `{ statusCode: 404, error: 'VIDEO_NOT_FOUND', message: ... }`
- A service throwing `VideoFileTooLargeException` results in a `413` response with `error: 'VIDEO_FILE_TOO_LARGE'`
- Generated public ids are always 11 characters long and URL-safe

---

### SI-03.7 — Video Processing Queue (Producer)

**Description:** Configure the BullMQ connection and the `video-processing` queue with the retry policy, and expose the producer that enqueues a processing job idempotently.

**Technical actions:**

1. Create `src/queue/queue.module.ts` — `BullModule.forRootAsync` reading the `queue` namespace (`REDIS_HOST`, `REDIS_PORT`) and import it in `AppModule` (per `phase-03-videos/TD-01`)
2. Create `src/videos/video-queue.constants.ts` exporting `VIDEO_PROCESSING_QUEUE = 'video-processing'` and the job name `process-video`
3. Register the queue in `VideosModule` with `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, defaultJobOptions })` — `attempts: 3`, exponential backoff with `delay: 5000`, `removeOnComplete` with an age limit, `removeOnFail: false` (per `phase-03-videos/TD-07`)
4. Create `src/videos/video-queue.service.ts` — `enqueueProcessing(videoId)` calling `queue.add('process-video', { videoId }, { jobId: 'video-' + videoId })` (per `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoQueueService` | Integration (real Redis): job added with payload `{ videoId }`, `jobId` `video-<uuid>`, `attempts: 3`; a second enqueue for the same video does not create a second job | `src/videos/video-queue.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- Enqueueing a video id creates exactly one job in the `video-processing` queue with payload `{ videoId }`
- Enqueueing the same video id again leaves exactly one job in the queue
- The job carries 3 attempts with exponential backoff of 5 seconds

---

### SI-03.8 — Upload Initialization and Ownership Lookup

**Description:** Implement the service side of the draft pre-registration: validate the declared file, create the multipart upload and the draft row, return the presigned part URLs, refresh part URLs, and resolve videos by public id for their owner.

**Technical actions:**

1. Add `ChannelsService.findByUserId(userId)` returning the caller's channel or `null` (each user owns exactly one channel)
2. Create `src/videos/videos.service.ts` with `initUpload(userId, dto)`: resolve the channel (`ChannelNotFoundException` when absent), reject sizes above `videos.maxSizeBytes` (`VideoFileTooLargeException`) and content types outside the allowed list (`UnsupportedVideoTypeException`), generate the video `id` (uuid) and `public_id`, build `source_key = videos/{id}/source`, call `StorageService.createMultipartUpload`, insert the `draft` row (default title = file name without extension, max 100 chars) retrying `generatePublicId` on unique violation `23505` up to 5 times, abort the multipart upload if the insert fails, and return the part plan (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`, `phase-03-videos/TD-07`, `phase-03-videos/TD-09`)
3. Implement `part_count = ceil(size_bytes / part_size_bytes)` and the presigned part URL list (`presignUploadPart` for part numbers `1..part_count`, expiry `videos.uploadUrlTtlSeconds`) as a private helper used by init and by refresh (per `phase-03-videos/TD-09`)
4. Implement `refreshPartUrls(userId, publicId, partNumbers)`: owner-only, only for `draft` videos (`VideoInvalidStatusException` otherwise), part numbers outside `1..part_count` throw `InvalidPartNumberException` (per `phase-03-videos/TD-06`)
5. Implement `findOwnedByPublicId(userId, publicId)` returning the video of the caller's channel or throwing `VideoNotFoundException` (also when the video belongs to someone else — no existence leak), used by status, complete, abort and refresh (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initUpload` / `refreshPartUrls` / `findOwnedByPublicId` | Unit: oversize → 413 exception, bad type → 415 exception, channel missing, `23505` retry then success, abort on insert failure, refresh rejected for non-draft, part numbers out of range → `InvalidPartNumberException`, default title derivation | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration (real DB + MinIO): init persists a `draft` row with `upload_id`, `source_key`, `part_size_bytes`; 103 parts for 10 GiB; another user's video is not found | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5, SI-03.6, SI-03.7

**Acceptance criteria:**

- Initializing an upload of 10 GiB (`10737418240` bytes) returns 103 part URLs and stores a `draft` video
- Initializing an upload of `10737418241` bytes fails with `VIDEO_FILE_TOO_LARGE`
- Initializing with `content_type` `application/pdf` fails with `UNSUPPORTED_VIDEO_TYPE`
- Omitting `title` stores the file name without extension (trimmed to 100 characters) as the title
- Asking for the video of another user's channel fails with `VIDEO_NOT_FOUND`
- Refreshing part URLs of a video that is no longer `draft` fails with `VIDEO_INVALID_STATUS`

---

### SI-03.9 — Upload Completion and Abort

**Description:** Implement the client-confirmed completion (multipart complete, size verification, `processing` transition, job enqueue) and the explicit abort of an upload in progress.

**Technical actions:**

1. Implement `VideosService.completeUpload(userId, publicId, parts)`: owner-only; the video must be `draft` (`VideoInvalidStatusException` otherwise); the parts list must contain exactly `part_count` entries numbered `1..part_count` (`VideoUploadIncompleteException`); call `StorageService.completeMultipartUpload` mapping storage errors (`InvalidPart`, `InvalidPartOrder`, `NoSuchUpload`, `EntityTooSmall`) to `VideoUploadIncompleteException` (per `phase-03-videos/TD-08`)
2. After the multipart completes, read the real object size with `headObjectSize`; when it exceeds `videos.maxSizeBytes` delete the object, set the video `failed` with `failure_reason = 'FILE_TOO_LARGE'` and throw `VideoFileTooLargeException` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-09`)
3. Persist `size_bytes` (actual size), clear `upload_id`, set `status = 'processing'` with the guarded update `WHERE status = 'draft'` and then call `VideoQueueService.enqueueProcessing(video.id)` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
4. Implement `VideosService.abortUpload(userId, publicId)`: owner-only, `draft` only, calls `StorageService.abortMultipartUpload` (ignoring `NoSuchUpload`) and deletes the draft row (per `phase-03-videos/TD-09`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` / `abortUpload` | Unit: wrong status, missing/duplicated/misnumbered parts, storage error mapping, oversize object deleted and video failed, enqueue called once after the guarded transition, abort of non-draft rejected | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration (real DB + MinIO + Redis): complete moves the video to `processing`, stores the real size and enqueues one job; abort removes the row and invalidates the upload | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- Completing a `draft` video with all parts moves it to `processing`, stores its real `size_bytes` and enqueues exactly one processing job
- Completing with a missing part fails with `VIDEO_UPLOAD_INCOMPLETE` and leaves the video `draft`
- Completing a video that is already `processing` fails with `VIDEO_INVALID_STATUS` and does not enqueue a second job
- Aborting a `draft` video deletes its row and makes its part URLs unusable
- Aborting a `ready` video fails with `VIDEO_INVALID_STATUS`

---

### SI-03.10 — Upload Orchestration Endpoints

**Description:** Expose the owner-only upload lifecycle over HTTP — init, refresh part URLs, complete, abort and status — with DTO validation, per-route throttling and OpenAPI documentation.

**Technical actions:**

1. Create the DTOs in `src/videos/dto/`: `InitVideoUploadDto` (`filename`, `content_type`, `size_bytes`, `title?`), `RefreshPartUrlsDto` (`part_numbers`), `CompleteVideoUploadDto` (`parts[]` of `{ part_number, etag }`) with `class-validator` rules of `#### Validation Rules` and the response classes with `@ApiProperty` (per `phase-02-auth/TD-06`)
2. Create `src/videos/videos.controller.ts` with `POST /videos`, `POST /videos/:publicId/upload/parts`, `POST /videos/:publicId/upload/complete`, `DELETE /videos/:publicId/upload` and `GET /videos/:publicId/status`, all protected by the global JWT guard and reading the caller with `@CurrentUser()` (per `phase-03-videos/TD-06`)
3. Apply `@Throttle({ default: { limit: 60, ttl: 60000 } })` to the four orchestration routes and `@Throttle({ default: { limit: 120, ttl: 60000 } })` to `status` (per `phase-03-videos/TD-09`)
4. Document every operation with `@ApiTags('videos')`, `@ApiOperation`, `@ApiResponse` for success and each predictable error with `ApiErrorEnvelope`, and `@ApiBearerAuth('access-token')` (per `openapi-docs-nestjs/TD-02`)
5. Register `VideosController`, `VideosService` and the `ChannelsModule`/`StorageModule` imports in `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `POST /videos`, `POST /videos/:publicId/upload/parts`, `POST /videos/:publicId/upload/complete`, `DELETE /videos/:publicId/upload`, `GET /videos/:publicId/status` | E2E: 401 without token, validation wiring (400), 201/200/202/204 happy paths against real MinIO/Redis, another user gets 404, 409 on wrong status | `test/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `POST /videos` without a token returns `401`
- `POST /videos` with `{ filename, content_type: 'video/mp4', size_bytes: 1048576 }` returns `201` with `public_id`, `status: 'draft'`, `part_size_bytes`, `part_count` and a `parts` array of presigned URLs
- `POST /videos` with an unknown property or a negative `size_bytes` returns `400` with `error: 'VALIDATION_ERROR'`
- `POST /videos/:publicId/upload/complete` after uploading the parts returns `202` with `status: 'processing'`
- `GET /videos/:publicId/status` returns `200` with the current `status` for the owner and `404 VIDEO_NOT_FOUND` for any other user
- `DELETE /videos/:publicId/upload` on a draft returns `204` and a later `GET /videos/:publicId/status` returns `404`

---

### SI-03.11 — Public Playback, Download and Thumbnail Endpoints

**Description:** Expose the public read side of a `ready` video — details, streaming, download and thumbnail — as authorized redirects to short-lived presigned storage URLs, with a stable API URL per video.

**Technical actions:**

1. Implement `VideosService.getReadyVideo(publicId)` (public lookup that throws `VideoNotFoundException` for any video that is not `ready`) and the redirect helpers `getStreamUrl`, `getDownloadUrl`, `getThumbnailUrl` using `StorageService.presignGet` with `videos.playbackUrlTtlSeconds` (per `phase-03-videos/TD-06`)
2. Add to `VideosController` the `@Public()` routes `GET /videos/:publicId`, `GET /videos/:publicId/stream`, `GET /videos/:publicId/download` and `GET /videos/:publicId/thumbnail`; the last three answer `302` with a `Location` header and `Cache-Control: no-store` (per `phase-03-videos/TD-06`)
3. Create `src/videos/dto/video-details.response.ts` with the public representation (`public_id`, `title`, `duration_seconds`, `size_bytes`, `content_type`, `metadata`, `created_at`, relative `stream_url`, `download_url`, `thumbnail_url`) (per `phase-03-videos/TD-04`)
4. Apply `@Throttle({ default: { limit: 120, ttl: 60000 } })` to the four public routes and document them with `@ApiResponse` (200/302/404) (per `phase-03-videos/TD-09`, `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getReadyVideo` and URL helpers | Unit: non-ready statuses → `VideoNotFoundException`, download URL carries the original file name | `src/videos/videos.service.spec.ts` |
| `GET /videos/:publicId`, `/stream`, `/download`, `/thumbnail` | E2E: anonymous access to a seeded `ready` video, `302` + `Location`, ranged request to the `Location` returns `206`, download has `Content-Disposition: attachment`, non-`ready` and unknown ids return `404 VIDEO_NOT_FOUND` | `test/videos-playback.e2e-spec.ts` |

**Dependencies:** SI-03.10

**Acceptance criteria:**

- `GET /videos/:publicId/stream` for a `ready` video without a token returns `302` with a `Location` to the storage
- A `GET` with `Range: bytes=0-99` against that `Location` returns `206` with the first 100 bytes — playback does not need the full file
- `GET /videos/:publicId/download` returns `302` to a URL whose response has `Content-Disposition: attachment` with the original file name
- `GET /videos/:publicId/thumbnail` returns `302` to the stored JPEG
- `GET /videos/:publicId` returns `200` with `duration_seconds`, `size_bytes`, `metadata` and the three relative URLs
- Any of the four routes returns `404 VIDEO_NOT_FOUND` for a `draft`, `processing` or `failed` video and for an unknown id

---

### SI-03.12 — FFmpeg Service (Probe and Thumbnail)

**Description:** Wrap `ffprobe` and `ffmpeg` in a service that extracts the persisted metadata and one JPEG frame from a (presigned) URL without a local copy of the video.

**Technical actions:**

1. Create `src/video-processing/ffmpeg.service.ts` with `probe(inputUrl)` running `ffprobe -v error -print_format json -show_format -show_streams <url>` through `child_process.spawn` with an argument array (never a shell string), a process timeout and bounded stdout buffering (per `phase-03-videos/TD-04`)
2. Create `src/video-processing/probe-result.ts` — pure functions that turn the `ffprobe` JSON into `{ durationSeconds, formatName, bitRate, video: { codec, width, height, frameRate } | null, audio: { codec, channels, sampleRate } | null }` and reject media without a video stream or a positive duration with `InvalidMediaError` (per `phase-03-videos/TD-04`)
3. Implement `extractThumbnail(inputUrl, durationSeconds, outputPath)` seeking to 10% of the duration (at least 1s when `durationSeconds >= 2`, otherwise frame 0), scaling to at most 1280px width and writing one JPEG with `-frames:v 1` (per `phase-03-videos/TD-04`)
4. Pass HTTP input options (`-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5`) before `-i` for presigned URLs (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `probe-result` parser and thumbnail time computation | Unit: durations, missing video stream, missing duration, rounding, seek rule for short and long videos | `src/video-processing/probe-result.spec.ts` |
| `FfmpegService` | Integration (real `ffmpeg`/`ffprobe`): a `testsrc` video generated with `ffmpeg -f lavfi` is probed (duration, codec, resolution) and a JPEG is extracted; non-media bytes raise `InvalidMediaError` | `src/video-processing/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Probing a 3-second generated video returns a duration of about 3 seconds, its container name and its video codec and resolution
- Extracting a thumbnail from that video writes a non-empty JPEG file
- Probing a file of random bytes fails with `InvalidMediaError`
- Probing a file with only an audio stream fails with `InvalidMediaError`

---

### SI-03.13 — Video Processing Service and Queue Consumer

**Description:** Implement the processing flow — probe, thumbnail, persist and transition — as a service and the BullMQ consumer that drives it with idempotent transitions and final-failure handling.

**Technical actions:**

1. Create `src/video-processing/video-processing.service.ts` with `process(videoId)`: load the video and return without side effects unless it is `processing`; presign an internal GET URL for `source_key`; call `FfmpegService.probe` and `extractThumbnail` into a temporary file; upload it to `videos/{id}/thumbnail.jpg` with `StorageService.putObject`; remove the temporary file in a `finally` block (per `phase-03-videos/TD-04`)
2. Persist the result with the guarded update `WHERE id = :id AND status = 'processing'` setting `status = 'ready'`, `duration_seconds`, `metadata` and `thumbnail_key`, so a replayed job never overwrites a finished video (per `phase-03-videos/TD-07`)
3. Implement `markFailed(videoId, reason)` with the same guard (`status = 'failed'`, `failure_reason` one of `INVALID_MEDIA`, `SOURCE_MISSING`, `PROCESSING_FAILED`) (per `phase-03-videos/TD-07`)
4. Create `src/video-processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` extending `WorkerHost`; `InvalidMediaError` becomes a BullMQ `UnrecoverableError` (no retries) after `markFailed('INVALID_MEDIA')`; any other error rethrows so BullMQ retries, and on the last attempt (`job.attemptsMade + 1 >= job.opts.attempts`) calls `markFailed('PROCESSING_FAILED')` first (per `phase-03-videos/TD-07`, `phase-03-videos/TD-01`)
5. Create `src/video-processing/video-processing.module.ts` providing the processor, `VideoProcessingService`, `FfmpegService` and importing `StorageModule`, `TypeOrmModule.forFeature([Video])` and the queue registration (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService`, `VideoProcessor` | Unit (mocked storage/ffmpeg/repo): non-`processing` video is a no-op, guarded update, invalid media → `markFailed` without retry, transient error rethrown and `markFailed` only on the last attempt, temp file removed | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration (real MinIO + ffmpeg + DB): uploaded generated video becomes `ready` with duration, metadata and a stored thumbnail; non-media object becomes `failed` with `INVALID_MEDIA`; running it twice is idempotent | `src/video-processing/video-processing.service.integration-spec.ts` |
| `VideoProcessingModule` | Unit: module compiles with the queue, storage and entity imports | `src/video-processing/video-processing.module.spec.ts` |

**Dependencies:** SI-03.7, SI-03.12, SI-03.5

**Acceptance criteria:**

- Processing a `processing` video whose source is a valid media file sets `status = 'ready'`, a positive `duration_seconds`, `metadata` with `format`, `bit_rate`, `video` and `audio` and a `thumbnail_key` whose object exists in the bucket
- Processing a `processing` video whose source is not media sets `status = 'failed'` with `failure_reason = 'INVALID_MEDIA'` on the first attempt
- Processing the same video a second time does not change the finished row
- A job for a video that is not `processing` completes without touching the row or the storage

---

### SI-03.14 — Worker Entrypoint and Compose Worker Service

**Description:** Run the consumer as a separate container from the same codebase: a standalone Nest application context that registers only the processing module, started by its own script and declared in Compose.

**Technical actions:**

1. Create `src/worker.module.ts` importing `ConfigModule.forRoot` (same `load` list and Joi schema as the API), `TypeOrmModule.forRootAsync`, `QueueModule` and `VideoProcessingModule`, and `src/worker.ts` bootstrapping it with `NestFactory.createApplicationContext` and `enableShutdownHooks()` so `SIGTERM` closes the BullMQ worker (per `phase-03-videos/TD-04`)
2. Add the scripts `start:worker` (`ts-node -r tsconfig-paths/register src/worker.ts`) and `start:worker:prod` (`node dist/worker`) to `package.json` (per `phase-03-videos/TD-04`)
3. Add the `video-worker` service to `compose.yaml` — same build and volume as `nestjs-api`, `command: npm run start:worker`, `restart: unless-stopped`, depending on `db`, `redis` and `minio` with `condition: service_healthy` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-04`)
4. Keep `AppModule` free of processor providers so only the worker container consumes the queue (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: the worker module compiles with the real config schema and exposes the processor | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.13, SI-03.2

**Acceptance criteria:**

- `docker compose up -d` starts the `video-worker` container and it stays `running`
- With the API and the worker running, a video completed through the API reaches `ready` without any test process consuming the queue
- Stopping the `video-worker` container leaves newly completed videos in `processing` until the worker is started again, and they then reach `ready`
- The API container never consumes the `video-processing` queue

---

### SI-03.15 — End-to-End Upload and Processing Flow

**Description:** Prove the whole phase in one place: register, upload a real multi-part video straight to MinIO, let the worker process it and watch it from the public endpoints, plus the failure path for non-media content.

**Technical actions:**

1. Create `test/videos-flow.e2e-spec.ts` booting `AppModule` plus `VideoProcessingModule` (in-process worker) with the global pipes and filters of `main.ts`, a part size of 5 MiB and `S3_PUBLIC_ENDPOINT` pointing at the Compose host `minio` so the test process can use the presigned URLs (per `phase-03-videos/TD-10`)
2. Generate the test video with `ffmpeg -f lavfi -i testsrc` (about 12 MiB, no binary fixtures) and upload every part with `fetch` `PUT` to the presigned URLs, collecting the `ETag` response headers (per `phase-03-videos/TD-10`, `phase-03-videos/TD-02`)
3. Drive the happy path init → parts → complete → poll `GET /videos/:publicId/status` until `ready` → `GET /videos/:publicId` → stream (`302` + `206` on a ranged request) → download → thumbnail (JPEG magic bytes) (per `phase-03-videos/TD-06`)
4. Drive the failure path with non-media bytes (declared `video/mp4`) reaching `failed` and the public routes returning `404`; clean up the per-run bucket prefix and queue in `afterAll` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Upload → processing → playback flow | E2E (real Postgres, MinIO, Redis, ffmpeg, in-process worker): multi-part upload, `ready` with duration/metadata/thumbnail, stream `206`, download attachment, thumbnail JPEG, invalid media → `failed` | `test/videos-flow.e2e-spec.ts` |

**Dependencies:** SI-03.11, SI-03.13

**Acceptance criteria:**

- A video uploaded in at least 3 parts directly to the storage through presigned URLs, then completed through the API, becomes `ready` with `duration_seconds` greater than 0
- The `ready` video exposes a stream URL whose ranged request returns `206`, a download URL with `Content-Disposition: attachment` and a thumbnail URL returning a JPEG
- A file that is not media ends `failed` with `failure_reason = 'INVALID_MEDIA'` and its public routes return `404`
- Two uploads started by the same user get different `public_id` values

---

### SI-03.16 — OpenAPI Contract and Documentation

**Description:** Regenerate the exported OpenAPI contract with the video endpoints and update the project documentation (`CLAUDE.md` files) so it matches the delivered code and Compose topology.

**Technical actions:**

1. Run `npm run openapi:export` and commit the regenerated `nestjs-project/openapi.json` (and `src/metadata.ts` if the Swagger plugin regenerates it) (per `openapi-docs-nestjs/TD-02`)
2. Update the root `CLAUDE.md` Architecture section: Message Queue is BullMQ on Redis, Object Storage is MinIO (S3 API), the Video Worker is the `video-worker` Compose service running `ffmpeg` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`)
3. Update `nestjs-project/CLAUDE.md`: Compose services (`minio`, `redis`, `video-worker`), ports, the `S3_*`, `REDIS_*` and `VIDEO_*` variables, the `start:worker` script, serial `npm test`, the `videos`/`storage`/`queue`/`video-processing` modules and the docker-network rule for `S3_PUBLIC_ENDPOINT` in tests (per `phase-03-videos/TD-11`, `phase-03-videos/TD-10`)
4. Update `docs/phases/phase-03-videos/progress.md` with the final state of every SI

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Exported OpenAPI document | Integration: the exported document lists the nine video paths and the `videos` tag | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.15

**Acceptance criteria:**

- `nestjs-project/openapi.json` contains `POST /videos`, `POST /videos/{publicId}/upload/parts`, `POST /videos/{publicId}/upload/complete`, `DELETE /videos/{publicId}/upload`, `GET /videos/{publicId}/status`, `GET /videos/{publicId}`, `GET /videos/{publicId}/stream`, `GET /videos/{publicId}/download` and `GET /videos/{publicId}/thumbnail`
- Every service, port, environment variable and script named in the two `CLAUDE.md` files exists in `compose.yaml`, `.env.example` and `package.json`
- `npx tsc --noEmit` exits with code 0, `npm run lint` passes and the full `npm test` and `npm run test:e2e` pass

---

## Technical Specifications

### Data Model

#### Video

Table `videos`. Entity `Video` in `src/videos/entities/video.entity.ts`; `VideoStatus` enum in `src/videos/entities/video-status.enum.ts`.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (the service assigns it explicitly at init so `source_key` can be built before the insert) |
| public_id | varchar(11) | unique, not null — 11-char URL-safe random identifier used in all public URLs |
| channel_id | uuid | FK → `channels.id`, ON DELETE CASCADE, not null |
| title | varchar(100) | not null |
| status | enum `video_status` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` |
| original_filename | varchar(255) | not null |
| content_type | varchar(100) | not null — declared at init, one of the allowed video types |
| size_bytes | bigint | not null — declared size at init, replaced by the real object size at completion; mapped to `number` |
| part_size_bytes | integer | not null — multipart part size chosen at init (policy snapshot) |
| upload_id | varchar(512) | nullable — S3 multipart upload id; cleared at completion |
| source_key | varchar(255) | not null — `videos/{id}/source` |
| thumbnail_key | varchar(255) | nullable — `videos/{id}/thumbnail.jpg`, set when `ready` |
| duration_seconds | numeric(12,3) | nullable — mapped to `number`, set when `ready` |
| metadata | jsonb | nullable — `{ format, bit_rate, video: { codec, width, height, frame_rate } \| null, audio: { codec, channels, sample_rate } \| null }`, set when `ready` |
| failure_reason | varchar(64) | nullable — `INVALID_MEDIA`, `SOURCE_MISSING`, `PROCESSING_FAILED` or `FILE_TOO_LARGE`, set when `failed` |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), updated on change |

**Relations:** `Channel` has many `Video` (many-to-one from `Video.channel`, cascade delete at the database level)
**Indexes:** unique on `public_id`; index on `channel_id`

**Status lifecycle:** `draft` (created at init) → `processing` (set at completion, job enqueued) → `ready` | `failed`. A draft is removed by the abort endpoint. Transitions to `processing`, `ready` and `failed` are guarded updates (`WHERE status = <expected>`).

---

### API Contracts

#### POST /videos (SI-03.10)

Owner-only. Creates the draft pre-registration and the S3 multipart upload and returns the presigned part URLs. Throttle: 60/min.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- filename: string, required — 1 to 255 characters
- content_type: string, required — one of `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska` (checked in the service → `415 UNSUPPORTED_VIDEO_TYPE`)
- size_bytes: integer, required — minimum 1; maximum `VIDEO_MAX_SIZE_BYTES` (10 GiB, checked in the service → `413 VIDEO_FILE_TOO_LARGE`)
- title: string, optional — 1 to 100 characters; defaults to the file name without extension trimmed to 100 characters

**Response 201:**
- public_id: string (11 characters)
- title: string
- status: string (`draft`)
- part_size_bytes: integer
- part_count: integer
- expires_in_seconds: integer
- parts: array of `{ part_number: integer, url: string }` — presigned `UploadPart` URLs (`PUT`, response header `ETag` must be kept by the client)

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 400 VALIDATION_ERROR: when the body fails schema validation
- 413 VIDEO_FILE_TOO_LARGE: when `size_bytes` exceeds the maximum
- 415 UNSUPPORTED_VIDEO_TYPE: when `content_type` is not an allowed video type
- 404 CHANNEL_NOT_FOUND: when the authenticated user has no channel
- 429 Too Many Requests: throttle exceeded

---

#### POST /videos/:publicId/upload/parts (SI-03.10)

Owner-only. Issues fresh presigned URLs for specific parts of a `draft` upload (URLs expire after `VIDEO_UPLOAD_URL_TTL_SECONDS`). Throttle: 60/min.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- part_numbers: array of integers, required — 1 to 10000 entries, each at least 1

**Response 200:**
- expires_in_seconds: integer
- parts: array of `{ part_number: integer, url: string }`

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 400 VALIDATION_ERROR: when the body fails schema validation
- 400 INVALID_PART_NUMBER: when a part number is outside `1..part_count`
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video of another user
- 409 VIDEO_INVALID_STATUS: when the video is not `draft`

---

#### POST /videos/:publicId/upload/complete (SI-03.10)

Owner-only. Confirms that every part was uploaded, completes the multipart upload, verifies the real size, moves the video to `processing` and enqueues the processing job. Throttle: 60/min.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required — exactly `part_count` entries of `{ part_number: integer (1..part_count), etag: string (1 to 256 characters) }`

**Response 202:**
- public_id: string
- status: string (`processing`)

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 400 VALIDATION_ERROR: when the body fails schema validation
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video of another user
- 409 VIDEO_INVALID_STATUS: when the video is not `draft`
- 413 VIDEO_FILE_TOO_LARGE: when the assembled object exceeds the maximum (the object is deleted and the video becomes `failed`)
- 422 VIDEO_UPLOAD_INCOMPLETE: when the parts list is incomplete or misnumbered, or the storage rejects the parts

---

#### DELETE /videos/:publicId/upload (SI-03.10)

Owner-only. Aborts a `draft` upload (multipart upload aborted, draft row removed). Throttle: 60/min.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content.

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video of another user
- 409 VIDEO_INVALID_STATUS: when the video is not `draft`

---

#### GET /videos/:publicId/status (SI-03.10)

Owner-only. Lets the uploader poll the processing outcome (public routes cannot see non-`ready` videos). Throttle: 120/min.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- public_id: string
- status: string (`draft`, `processing`, `ready` or `failed`)
- failure_reason: string | null

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video of another user

---

#### GET /videos/:publicId (SI-03.11)

Public (`@Public()`), `ready` videos only. Throttle: 120/min.

**Response 200:**
- public_id: string
- title: string
- duration_seconds: number
- size_bytes: number
- content_type: string
- metadata: object (`format`, `bit_rate`, `video`, `audio` as stored)
- created_at: string (ISO 8601)
- stream_url: string — `/videos/{publicId}/stream`
- download_url: string — `/videos/{publicId}/download`
- thumbnail_url: string — `/videos/{publicId}/thumbnail`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video not `ready`
- 429 Too Many Requests: throttle exceeded

---

#### GET /videos/:publicId/stream (SI-03.11)

Public, `ready` videos only. Redirects to a presigned storage URL valid for `VIDEO_PLAYBACK_URL_TTL_SECONDS`; the storage serves `Range` (`206`). Throttle: 120/min.

**Response 302:** `Location` header with the presigned GET URL (inline); `Cache-Control: no-store`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video not `ready`
- 429 Too Many Requests: throttle exceeded

---

#### GET /videos/:publicId/download (SI-03.11)

Public, `ready` videos only. Same as `stream` but the presigned URL carries `ResponseContentDisposition: attachment; filename="<original_filename>"`. Throttle: 120/min.

**Response 302:** `Location` header with the presigned GET URL (attachment); `Cache-Control: no-store`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video not `ready`
- 429 Too Many Requests: throttle exceeded

---

#### GET /videos/:publicId/thumbnail (SI-03.11)

Public, `ready` videos only. Redirects to the presigned URL of `videos/{id}/thumbnail.jpg`. Throttle: 120/min.

**Response 302:** `Location` header with the presigned GET URL; `Cache-Control: no-store`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video not `ready`
- 429 Too Many Requests: throttle exceeded

---

#### Validation Rules — video upload DTOs

- `filename`: required string, 1 to 255 characters
- `content_type`: required string (allowed list enforced by the service)
- `size_bytes`: required integer, minimum 1 (upper bound enforced by the service)
- `title`: optional string, 1 to 100 characters
- `part_numbers`: required array, 1 to 10000 integers, each at least 1
- `parts`: required array, 1 to 10000 items; `part_number` integer at least 1, `etag` string of 1 to 256 characters
- Unknown properties are rejected (global `ValidationPipe` with `forbidNonWhitelisted`)

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ (own channel) | ✓ |
| POST /videos/:publicId/upload/parts | ✗ | ✗ | ✓ |
| POST /videos/:publicId/upload/complete | ✗ | ✗ | ✓ |
| DELETE /videos/:publicId/upload | ✗ | ✗ | ✓ |
| GET /videos/:publicId/status | ✗ | ✗ | ✓ |
| GET /videos/:publicId (ready only) | ✓ | ✓ | ✓ |
| GET /videos/:publicId/stream (ready only) | ✓ | ✓ | ✓ |
| GET /videos/:publicId/download (ready only) | ✓ | ✓ | ✓ |
| GET /videos/:publicId/thumbnail (ready only) | ✓ | ✓ | ✓ |

"Owner" = the video belongs to the caller's channel. A non-owner on an owner-only route receives `404 VIDEO_NOT_FOUND` (no existence leak).

---

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VALIDATION_ERROR | 400 | Request body or parameters fail DTO validation (inherited format) |
| INVALID_PART_NUMBER | 400 | A requested part number is outside `1..part_count` |
| VIDEO_NOT_FOUND | 404 | Unknown `publicId`, a non-owner on an owner-only route, or a video that is not `ready` on a public route |
| CHANNEL_NOT_FOUND | 404 | The authenticated user has no channel |
| VIDEO_INVALID_STATUS | 409 | Operation not allowed in the video's current status (e.g. complete or abort when not `draft`) |
| VIDEO_FILE_TOO_LARGE | 413 | Declared or real file size exceeds `VIDEO_MAX_SIZE_BYTES` |
| UNSUPPORTED_VIDEO_TYPE | 415 | Declared `content_type` is not an allowed video type |
| VIDEO_UPLOAD_INCOMPLETE | 422 | Parts list incomplete or misnumbered, or the storage rejected the multipart completion |

`401 Unauthorized` (global JWT guard) and `429 Too Many Requests` (throttler) keep the formats inherited from Phase 02.

---

### Events/Messages

#### video.process

Queue `video-processing` (BullMQ on Redis), job name `process-video`, `jobId` = `video-{videoId}`.

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoQueueService` (called by `VideosService.completeUpload`) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`)
**Consumer:** `VideoProcessor` in the `video-worker` container (per `phase-03-videos/TD-04`)
**Trigger:** the client confirms the upload and the video moves from `draft` to `processing`
**Delivery semantics:** at-least-once with 3 attempts and exponential backoff (5s base); idempotent consumption through the guarded `processing` → `ready` | `failed` transitions and the deduplicating `jobId` (per `phase-03-videos/TD-07`)

---

## Dependency Map

SI-03.1 (root)
├── SI-03.2 — depends on SI-03.1 (Compose services need the env conventions and image tooling in place)
├── SI-03.3 — depends on SI-03.1 (new dependencies installed before configuration namespaces)
│   └── SI-03.4 — depends on SI-03.3 (entity and module need the validated configuration)
│       ├── SI-03.6 — depends on SI-03.4 (exceptions and public id feed the service)
│       └── SI-03.7 — depends on SI-03.2, SI-03.3, SI-03.4 (queue needs Redis, the queue namespace and the module)
├── SI-03.5 — depends on SI-03.2, SI-03.3 (storage service needs MinIO and the storage namespace)
└── SI-03.12 — depends on SI-03.1 (ffmpeg binaries in the image)
SI-03.8 — depends on SI-03.5, SI-03.6, SI-03.7 (init needs storage, errors and queue module)
└── SI-03.9 — depends on SI-03.8 (completion builds on the ownership lookup and part plan)
    └── SI-03.10 — depends on SI-03.9 (controller exposes the service)
        └── SI-03.11 — depends on SI-03.10 (public routes extend the controller)
SI-03.13 — depends on SI-03.5, SI-03.7, SI-03.12 (processing needs storage, the queue and ffmpeg)
└── SI-03.14 — depends on SI-03.13, SI-03.2 (worker process and container)
SI-03.15 — depends on SI-03.11, SI-03.13 (full flow needs the public routes and the consumer)
└── SI-03.16 — depends on SI-03.15 (contract export and docs after the behavior is proven)

---

## Deliverables

- [ ] SI-03.1 — Dependencies, Test Script and Image Tooling
- [ ] SI-03.2 — MinIO and Redis in Docker Compose
- [ ] SI-03.3 — Storage, Queue and Video Configuration Namespaces
- [ ] SI-03.4 — Video Entity, Migration and Test Cleanup
- [ ] SI-03.5 — Storage Service (S3-compatible)
- [ ] SI-03.6 — Video Domain Exceptions and Public Identifier
- [ ] SI-03.7 — Video Processing Queue (Producer)
- [ ] SI-03.8 — Upload Initialization and Ownership Lookup
- [ ] SI-03.9 — Upload Completion and Abort
- [ ] SI-03.10 — Upload Orchestration Endpoints
- [ ] SI-03.11 — Public Playback, Download and Thumbnail Endpoints
- [ ] SI-03.12 — FFmpeg Service (Probe and Thumbnail)
- [ ] SI-03.13 — Video Processing Service and Queue Consumer
- [ ] SI-03.14 — Worker Entrypoint and Compose Worker Service
- [ ] SI-03.15 — End-to-End Upload and Processing Flow
- [ ] SI-03.16 — OpenAPI Contract and Documentation

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] `docker compose ps` shows `db`, `mailpit`, `minio`, `redis`, `video-worker` running
