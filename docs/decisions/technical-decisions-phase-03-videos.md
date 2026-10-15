---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-15
scope_description: "Backend foundation for video upload and processing: message queue, 10GB upload strategy, object-storage integration, video worker/FFmpeg, unique public id, streaming/download delivery, status lifecycle, upload limits, test strategy and Compose topology."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that owns the video module, the S3-compatible storage client, the BullMQ producer, the video worker (separate container, same codebase) and the new Compose services (object storage, Redis, worker).
- `next-frontend/` — no open decision in this document: the task statement keeps the video UI out of scope for this phase. The API contract (presigned multipart handshake, stream/download redirects) is published through the existing OpenAPI export so a future frontend phase can consume it without a new TD.

Inherited and therefore **not reopened** here (see `docs/decisions/`): NestJS config via `registerAs` + Joi (`phase-01-configuracao-base`), class-validator DTOs, domain exception filter and `{ statusCode, error, message }` error envelope, global JWT guard with `@Public()`, rate limiting with `@nestjs/throttler` (`phase-02-auth`), TypeORM migrations (`phase-01-configuracao-base`). Object storage = S3-compatible (MinIO locally) is given by the project architecture (`docs/diagrams/software-arch.mermaid`) and is not a decision; **how** it is used is (TD-03, TD-12).

_Decision provenance:_ all TDs below were decided on 2026-10-15 by adopting each **Recommendation**; the user delegated the whole challenge ("faça o desafio técnico ... resolva") to the executing agent, so no separate approval round happened. Parameter-level clarifications raised by `/plan-validate` (IC/AMB/DG/ICC) are recorded as `**Note:**` lines on the TD they refine.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and `CLAUDE.md` leave the queue as "TBD". The API must hand a "process this video" job to a separate worker container and survive restarts, with retries when FFmpeg or storage fail. This is the main open stack decision of the phase; the PostgreSQL (TypeORM) and NestJS 11 stack is already fixed.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq`)
- Redis-backed job queue with first-class NestJS integration (`BullModule.registerQueue`, `@Processor` + `WorkerHost`, `@InjectQueue`). Retries are native (`attempts`, exponential `backoff`), failed jobs stay in a failed set, `jobId` gives idempotent enqueue.
- **Pros:** Smallest amount of glue code in NestJS; retry/backoff/concurrency/stalled-job recovery built in; producer and worker can live in different containers sharing only Redis; job inspection via Redis; mature (BullMQ is the successor of Bull).
- **Cons:** Adds Redis to the stack (one more container to persist and operate); durability depends on Redis persistence settings (AOF, `maxmemory-policy noeviction`); at-least-once delivery means handlers must be idempotent.

### Option B: RabbitMQ (AMQP via `amqplib` or `@nestjs/microservices`)
- A dedicated message broker with durable queues, acks and dead-letter exchanges. The worker consumes AMQP messages.
- **Pros:** Strong broker semantics (acks, DLX, routing); decouples languages (the worker could be non-Node).
- **Cons:** Heavier broker to run; retry with delay needs hand-built DLX/TTL topology; more boilerplate than BullMQ for this single queue; no job introspection UI by default.

### Option C: pg-boss (queue on PostgreSQL)
- Job queue stored in the existing PostgreSQL using `SKIP LOCKED`; no new infrastructure.
- **Pros:** Zero new container; transactional enqueue with the video row update (same DB); simple operations.
- **Cons:** Queue traffic shares the primary database; less NestJS integration (manual provider); lower throughput ceiling; job polling load on the transactional DB.

### Option D: AWS SQS (ElasticMQ locally)
- Managed queue in production, emulated locally.
- **Pros:** No broker to operate in AWS; native DLQ and visibility timeout.
- **Cons:** Needs an emulator image locally; weaker NestJS ergonomics; visibility-timeout tuning for long FFmpeg jobs; production vendor coupling not required by the plan.

**Recommendation:** Option A (BullMQ) — it is the lowest-friction fit for NestJS 11 (official `@nestjs/bullmq`), gives retries/backoff/idempotent `jobId` out of the box, and lets the worker be a second container of the same codebase sharing only Redis. The cost (Redis in Compose) is small and explicit.

**Decision:** A (BullMQ on Redis)

**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^5.x`

---

## TD-02: Large-File Upload Strategy (10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The API must not hold a 10GB request open or buffer it. The strategy defines the handshake between client and backend: who talks to storage, who finalizes the object, how failures/aborts are handled. S3 limits (AWS "multipart upload limits"): a single PUT is capped at 5 GiB, so a 10GB file requires multipart; parts are 5 MiB–5 GiB, up to 10,000 parts. Both the API (orchestration) and any future client (part uploads) are affected, so this is one cross-layer decision.

**Options:**

### Option A: Proxy upload through the API (`multipart/form-data` streamed to storage)
- Client sends the file to `POST /videos`; the API streams the body to storage.
- **Pros:** Simplest client; storage never exposed to browsers.
- **Cons:** Holds an API connection and bandwidth for the whole upload (violates "sem impacto na performance"); timeouts and proxies break at multi-GB; no resumability.

### Option B: Presigned single PUT URL
- API issues one presigned `PUT` URL; client uploads directly to storage.
- **Pros:** API leaves the data path; trivial handshake.
- **Cons:** Capped at 5 GiB by S3 — cannot satisfy 10GB; no resume on failure.

### Option C: S3 multipart upload with presigned part URLs, orchestrated by the API
- API creates the draft video + `CreateMultipartUpload`, returns `uploadId`, `partSize` and presigned `UploadPart` URLs; the client uploads parts in parallel directly to storage and sends back each part `ETag`; the API calls `CompleteMultipartUpload` (or `AbortMultipartUpload`).
- **Pros:** API never touches file bytes; parallel and retryable parts (resume by re-uploading failed parts); satisfies 10GB (100 parts of 100 MiB); works on S3 and MinIO with the same SDK code.
- **Cons:** Three-call protocol (init / complete / abort); client must collect ETags (needs CORS `ExposeHeaders: ETag` on storage); incomplete uploads leave orphan parts that need a lifecycle/cleanup rule.

### Option D: tus resumable upload protocol (`@tus/server`)
- Standard resumable-upload protocol with an S3 store.
- **Pros:** Client libraries and resumability off the shelf.
- **Cons:** Bytes still flow through a tus server we operate (or an extra service); another protocol to document/test; less aligned with the plan's S3-direct architecture.

**Recommendation:** Option C — it is the only option that keeps the API off the data path *and* clears the 5 GiB single-PUT ceiling; it mirrors the architecture diagram (Frontend streams to/from Object Storage; API publishes jobs). The orphan-parts cost is handled by TD-03/TD-12 (abort endpoint + storage lifecycle rule).

**Decision:** C (S3 multipart upload with presigned part URLs, orchestrated by the API)

**Libraries:** —

---

## TD-03: Object Storage Integration and Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage service is given (S3-compatible; MinIO locally). Open: which client library, how buckets/keys are organized for videos and thumbnails, and how the API signs URLs that a browser can reach while the API itself talks to storage over the Docker network (`CLAUDE.md`: always use the Compose service name as host, never `localhost`).

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), one bucket, per-video key prefix
- One bucket (e.g. `streamtube`); keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`. Two S3 clients: an internal one (endpoint `http://minio:9000`) for server-side calls and a presigning client whose endpoint is the public URL, because the host is part of the SigV4 signature.
- **Pros:** Same code runs on MinIO and real S3 (endpoint + `forcePathStyle` are config); official, modular, typed; keys group everything belonging to a video for cleanup and lifecycle rules.
- **Cons:** SDK v3 defaults to sending checksum headers that MinIO/presigned flows can reject (must set `requestChecksumCalculation: 'WHEN_REQUIRED'`); two clients to configure.

### Option B: `minio` JS client, two buckets (`videos`, `thumbnails`)
- MinIO's own SDK; separate buckets per asset type.
- **Pros:** Simple API for MinIO; bucket-level policy per type (e.g. public thumbnails).
- **Cons:** Ties code to MinIO; production S3 would require a rewrite or compatibility reliance; two buckets multiply config and lifecycle rules.

### Option C: AWS SDK v3, bucket per channel
- One bucket per channel/tenant.
- **Pros:** Hard isolation per channel.
- **Cons:** Bucket creation on signup, S3 bucket-count quotas, operational overhead with no requirement in the plan.

**Recommendation:** Option A — storage portability (MinIO now, S3 later) is the stated intent of the architecture; a single bucket with `videos/{videoId}/…` keys keeps the model trivial and makes per-video deletion and the abort-incomplete-multipart lifecycle rule straightforward.

**Decision:** A (AWS SDK v3, single bucket, per-video key prefix)

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

---

## TD-04: Video Worker Execution Model and FFmpeg Integration

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture has a separate **Video Worker (FFmpeg)** container that consumes jobs, updates the DB and storage. Open: how the worker is packaged and how it invokes FFmpeg/ffprobe on files up to 10GB without exhausting container disk or memory.

**Options:**

### Option A: Same codebase, second entrypoint/container; invoke `ffprobe`/`ffmpeg` binaries with `child_process.spawn` against a presigned GET URL
- A NestJS standalone application context (`src/worker.ts`) registers only the BullMQ `@Processor`; Compose runs it as `video-worker` from the same image with `ffmpeg` installed. The worker presigns a short-lived GET URL for the stored object and passes it as input, so FFmpeg reads via HTTP range requests (no 10GB local copy); the thumbnail is written to a temp file and uploaded.
- **Pros:** Reuses entities, config, repository and test infra; no full download; spawn with an argument array avoids shell injection; one language/toolchain.
- **Cons:** `ffmpeg` binary in the image; some containers (e.g. MP4 with `moov` atom at the end) cause more range requests; worker and API deploy together.

### Option B: Same as A but download the object to a temp dir first
- **Pros:** Simplest FFmpeg invocation; deterministic reads.
- **Cons:** Needs up to 10GB of scratch disk per concurrent job; slow start; wasteful when only metadata and one frame are needed.

### Option C: Wrapper library `fluent-ffmpeg`
- **Pros:** Fluent API.
- **Cons:** The package is archived/deprecated upstream; still shells out to the same binaries; adds a dependency for two commands.

### Option D: Independent worker service in another language/repo
- **Pros:** Isolation, independent scaling/stack.
- **Cons:** Duplicates the data model and config; heavy for this phase; breaks "continuity, not rework".

**Recommendation:** Option A — it gives a real, separate worker container with minimal duplication and avoids the 10GB local copy that Option B would need. Thumbnail frame: seek to 10% of the duration (clamped to ≥ 1s when the video is long enough, otherwise frame 0) and scale to max 1280px width; metadata via `ffprobe -print_format json -show_format -show_streams`.

**Decision:** A (same codebase, separate worker container, `spawn` on a presigned GET URL)

**Note:** Metadata persisted by the worker (resolves validation AMB-3): typed columns `duration_seconds` (numeric) and `size_bytes` (bigint), plus a `metadata` jsonb column with `format` (container name), `bit_rate`, `video` (`codec`, `width`, `height`, `frame_rate`) and `audio` (`codec`, `channels`, `sample_rate`) as reported by `ffprobe`. The thumbnail is stored at `videos/{videoId}/thumbnail.jpg` and its key persisted in `thumbnail_key`.

**Libraries:** `ffmpeg` (system binaries `ffmpeg`/`ffprobe` installed in the image via apt; not an npm package)

---

## TD-05: Unique Public Video Identifier (URL)

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a unique, URL-safe identifier exposed in the public URL. The identifier must exist at draft time (title may still be empty), must not leak counts or order, and collisions must be impossible to persist.

**Options:**

### Option A: Expose the primary-key UUID v4
- **Pros:** No extra column; collision-free by construction.
- **Cons:** 36-char URLs; couples the public URL to the internal primary key (cannot change later without breaking links).

### Option B: Separate `public_id` — 11-char URL-safe random string (8 random bytes, base64url) with a unique index and retry on conflict
- **Pros:** Short YouTube-like URL; independent of the PK; 64 bits of entropy makes collisions negligible and the unique index makes them impossible to persist (retry on `23505`); available at draft time.
- **Cons:** Extra column/index; needs a bounded retry loop.

### Option C: Title-based slug with numeric suffix
- **Pros:** Human-readable.
- **Cons:** Title is not known at draft creation and changes later; requires uniqueness juggling and redirects.

**Recommendation:** Option B — short, opaque, stable and generated at draft time; the DB unique constraint is the real guarantee, the random space only keeps retries rare.

**Decision:** B (11-char random `public_id`, unique index, retry on conflict)

**Libraries:** —

---

## TD-06: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Browsers play video with HTTP range requests (`206 Partial Content`). Streaming and download must work without the API carrying the bytes, anonymous users must be able to watch (project overview), and the frontend (a `<video src>`/link) depends on the URL shape.

**Options:**

### Option A: API proxies the object and implements `Range`/`206` itself
- **Pros:** Storage stays private; single origin.
- **Cons:** API carries every byte of every playback (the opposite of the upload decision); must implement range, caching and backpressure correctly.

### Option B: API endpoint authorizes and `302`-redirects to a short-lived presigned GET URL; storage serves `Range`
- `GET /videos/{publicId}/stream` redirects to a presigned URL (inline); `GET /videos/{publicId}/download` redirects to a presigned URL with `ResponseContentDisposition: attachment`.
- **Pros:** API off the data path; storage natively answers `Range` with `206`; one stable public URL per video; download/stream differ only by response disposition.
- **Cons:** Presigned URL expires (client re-requests); storage endpoint must be reachable by the client and allow CORS/Range; redirect adds one hop.

### Option C: Public-read bucket / CDN direct URLs
- **Pros:** Fastest delivery path, trivially cacheable.
- **Cons:** No authorization point (drafts/failed videos could leak), the stable "unique URL" is the storage URL; not aligned with the project's later visibility rules.

**Recommendation:** Option B — keeps the data path off the API like TD-02, preserves an authorization point (only `ready` videos are public), and relies on storage-native `206`. The stable URL the user shares is the API URL, not a storage URL.

**Decision:** B (302 redirect to a short-lived presigned GET URL; storage serves Range)

**Note:** Access rules (resolves validation AMB-2): `init`, part-URL refresh, `complete`, `abort` and `GET /videos/{publicId}/status` are owner-only (authenticated, video belongs to the caller's channel); `GET /videos/{publicId}`, `stream`, `download` and `thumbnail` of a `ready` video are public (`@Public()`, anonymous users watch freely) — equivalent to link-only/unlisted access — and answer `404 VIDEO_NOT_FOUND` for any non-`ready` video (the global JWT guard does not populate the user on `@Public()` routes, so owner polling uses the dedicated `/status` route). Visibility (public vs unlisted) and the draft → publication flow are Phase 04 capabilities and are layered on top of this rule without changing the URL.

**Libraries:** —

---

## TD-07: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row is created as a draft at upload start and then moves through processing. The status values, who writes each transition, and what happens on failure (retries, final state, visibility) must be explicit because API and worker both mutate the row.

**Options:**

### Option A: Four states — `draft` → `processing` → `ready` | `failed`
- `draft`: created at init, upload in progress or awaiting completion. `processing`: upload completed and job enqueued. `ready`: duration, metadata and thumbnail stored. `failed`: final failure with `failure_reason`. BullMQ retries 3 times with exponential backoff (5s base); only after the last attempt is the row set to `failed`. The worker transition is guarded (`WHERE status = 'processing'`) so replays are idempotent.
- **Pros:** Matches the required cycle exactly; simple guards; failed videos stay visible to the owner with a reason.
- **Cons:** No separate "uploading" state; stale drafts need a later cleanup phase.

### Option B: Five states adding `uploading`
- **Pros:** Distinguishes "init" from "parts being sent".
- **Cons:** API cannot observe part uploads (client talks to storage), so the extra state would never be set reliably.

### Option C: Status history table (event log)
- **Pros:** Full audit trail.
- **Cons:** Over-engineering for this phase; no requirement for history.

**Recommendation:** Option A — it is the cycle the task statement names (rascunho → processando → pronto/erro), and the guarded transition plus BullMQ `jobId = videoId` makes duplicate completion or replayed jobs harmless.

**Decision:** A (draft → processing → ready | failed)

**Note:** Draft title (resolves validation AMB-1): `POST /videos` accepts an optional `title` (max 100 chars); when omitted it defaults to the file name without extension trimmed to 100 chars. Editing the title is Phase 04. Stale `draft` rows are not purged in this phase (recorded in `## Non-UI / Deferred Capabilities`).

**Libraries:** —

---

## TD-08: Upload Completion Trigger

**Scope:** Cross-layer

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Something must tell the system that the upload finished so the object is assembled and the job is enqueued. With S3 multipart, the object only exists after `CompleteMultipartUpload`, which needs the part list and ETags.

**Options:**

### Option A: Client-confirmed `POST /videos/{id}/upload/complete` with the part list; API completes the multipart upload, verifies size, enqueues the job
- **Pros:** Deterministic; the API already holds the `uploadId` and can validate the final size (`HeadObject`) against the 10GB limit before enqueueing; works identically on MinIO and S3.
- **Cons:** Relies on the client calling it (an abandoned upload stays `draft`).

### Option B: Storage event notification (webhook/queue) triggers processing
- **Pros:** Server-driven.
- **Cons:** Multipart assembly still needs someone to call `CompleteMultipartUpload`; extra notification infrastructure to configure on MinIO/S3.

**Recommendation:** Option A — the part list is only known to the client, completion is a required API call anyway, and the size verification gate lives naturally there.

**Decision:** A (client-confirmed `POST /videos/{publicId}/upload/complete`)

**Libraries:** —

---

## TD-09: Upload Limits and Policies

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The numbers that shape the multipart handshake (maximum size, part size, URL lifetime, accepted content types) are cross-cutting between DTO validation, service and storage, so they must be fixed once.

**Options:**

### Option A: Server-chosen fixed policy
- Max size 10 GiB (`10 * 1024^3` bytes); part size 100 MiB (10 GiB → 103 parts, well under the 10,000-part cap; ≥ 5 MiB minimum); presigned part URLs valid 6 hours; declared content types `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`; the declared size is verified with `HeadObject` after completion and the object is deleted if it exceeds the limit; real media validation happens in the worker (`ffprobe` failure → `failed`).
- **Pros:** Predictable; limits live in one config namespace (`storage.*`/`videos.*`); easy to test.
- **Cons:** Fixed part size is not tuned per connection.

### Option B: Client-chosen part size within server bounds
- **Pros:** Client can tune throughput.
- **Cons:** More validation surface; no requirement for it in this phase.

**Recommendation:** Option A — simplest policy that satisfies 10GB with large safety margin on the part count; values come from env (Joi-validated) so they stay adjustable without code changes.

**Decision:** A (server-chosen fixed policy: 10 GiB, 100 MiB parts, 6h presigned URLs)

**Note:** Cleanup scope (resolves validation AMB-4): an explicit `DELETE /videos/{publicId}/upload` aborts the multipart upload and removes the draft; the storage bucket also gets a lifecycle rule aborting incomplete multipart uploads after 1 day. Rate-limit policy (resolves validation ICC-1, refining `phase-02-auth/TD-08` which is not superseded): upload-orchestration routes use `@Throttle({ default: { limit: 60, ttl: 60000 } })`; public read routes (`GET /videos/{publicId}`, `stream`, `download`, `thumbnail`) and the owner `status` route use `@Throttle({ default: { limit: 120, ttl: 60000 } })`; the global 10/min default stays for auth routes.

**Libraries:** —

---

## TD-10: Test Strategy for Queue, Storage and Worker

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The task requires real Redis, storage and FFmpeg to be exercised ("não mocke o que dá para testar de verdade"). The project's integration tests already run against the Compose database; the same pattern must extend to the new services.

**Options:**

### Option A: Run against the Compose services (real MinIO, Redis, `ffmpeg`); worker started in-process in e2e
- Unit tests mock collaborators; integration tests hit real MinIO/Redis/PostgreSQL; e2e boots `AppModule` plus the worker processor in the same Jest process and drives the whole flow (init → part upload → complete → `ready` → stream `206`). Test media is generated with `ffmpeg lavfi` (`testsrc`), no binary fixtures.
- **Pros:** Real infrastructure end to end, consistent with the existing DB integration tests; no extra tooling.
- **Cons:** Requires the Compose stack to be up; tests share Redis/bucket (need per-test cleanup and prefixes).

### Option B: Testcontainers
- **Pros:** Isolated, self-provisioned.
- **Cons:** Docker-in-Docker from inside the `nestjs-api` container; new dependency; diverges from the project's existing pattern.

### Option C: Mock storage and queue
- **Pros:** Fast and infra-free.
- **Cons:** Rejected by the task statement and hides the integration bugs this phase is about (signature host, ETag exposure, retries).

**Recommendation:** Option A — it matches the existing integration-test pattern and satisfies the explicit "infra real" requirement; per-run unique bucket prefixes and queue cleanup keep tests isolated.

**Decision:** A (real Compose services; in-process worker in e2e)

**Note:** Serial test execution (resolves validation IC-1): the `test` npm script becomes `jest --runInBand` so DB-backed suites never run in parallel workers (`test:integration` keeps `--runInBand`); `cleanAllTables` is extended with the new `videos` table.

**Libraries:** —

---

## TD-11: Docker Compose Topology and Environment Contract

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)"

**Context:** Storage, queue and worker must come up with the backend stack, and their connection settings are cited in several files (`compose.yaml`, Joi schema, `.env.example`, config namespaces) — a cross-component contract. Fact verified on 2026-10-15: the `minio/minio` and `minio/mc` repositories no longer exist on Docker Hub (HTTP 404), so the image choice itself is a decision.

**Options:**

### Option A: `bitnamilegacy/minio:2025.7.23-debian-12-r5` (pinned real MinIO server) + `redis:7-alpine` + `video-worker` from the API image
- Services: `minio` (API 9000, console 9001, default bucket created via `MINIO_DEFAULT_BUCKETS`, CORS via `MINIO_API_CORS_ALLOW_ORIGIN`), `redis` (AOF on, `noeviction`), `video-worker` (same Dockerfile with `ffmpeg`, command `npm run start:worker`). Env keys: `S3_ENDPOINT` (internal), `S3_PUBLIC_ENDPOINT` (signing host for clients), `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `REDIS_HOST`, `REDIS_PORT`, plus the limits from TD-09.
- **Pros:** Real MinIO (as the plan states), same S3 API as production; one pinned tag; no init container needed.
- **Cons:** The image is a frozen legacy build (no further updates) — acceptable for local development only; documented as such.

### Option B: RustFS (`rustfs/rustfs`) as the S3-compatible server
- **Pros:** Actively maintained image.
- **Cons:** Not MinIO as the project states; younger project, S3 feature parity (multipart, CORS, lifecycle) must be validated; diverges from the task statement.

### Option C: Build MinIO from the upstream source tarball
- **Pros:** Always current.
- **Cons:** Long builds and bespoke Dockerfile for a local-only service.

**Recommendation:** Option A — it keeps MinIO literally, with a pinned tag, and isolates the storage choice behind the `S3_*` contract so swapping the image (or going to AWS S3) changes only Compose and env, not code.

**Decision:** A (pinned `bitnamilegacy/minio` + `redis:7-alpine` + `video-worker` from the API image)

**Note:** Environment hygiene (resolves validation DG-1): `.env.example` quotes the whole `MAIL_FROM` value so `docker compose` can parse it; new keys (`S3_*`, `REDIS_*`, upload limits) are added to `.env.example`, `env.validation.ts` and the config namespaces together.

**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | A (BullMQ on Redis) | A |
| TD-02 | Cross-layer | Large-File Upload Strategy (10GB) | C (S3 multipart, presigned parts) | C |
| TD-03 | Backend | Object Storage Integration and Key Layout | A (AWS SDK v3, single bucket, per-video keys) | A |
| TD-04 | Backend | Video Worker Execution Model and FFmpeg Integration | A (same codebase, separate container, spawn on presigned URL) | A |
| TD-05 | Backend | Unique Public Video Identifier (URL) | B (11-char random `public_id`, unique index) | B |
| TD-06 | Cross-layer | Streaming and Download Delivery | B (302 to presigned GET, storage serves Range) | B |
| TD-07 | Backend | Video Status Lifecycle and Failure Handling | A (draft → processing → ready/failed) | A |
| TD-08 | Cross-layer | Upload Completion Trigger | A (client-confirmed complete endpoint) | A |
| TD-09 | Backend | Upload Limits and Policies | A (10 GiB, 100 MiB parts, fixed policy) | A |
| TD-10 | Backend | Test Strategy for Queue, Storage and Worker | A (real Compose services, in-process worker in e2e) | A |
| TD-11 | Repo-wide | Docker Compose Topology and Environment Contract | A (pinned MinIO image + Redis + worker service) | A |
