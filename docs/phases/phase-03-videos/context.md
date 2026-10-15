---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-15T15:11:36-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-15T15:34:02-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-15T15:12:21-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-10-15T15:12:21-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-10-15T15:12:21-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-15T15:12:21-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-15T15:12:21-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-15T15:34:02-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-15T15:11:36-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Gerenciamento de vídeos e canal (edição de metadados, listagem, publicação, exclusão — Fase 04), comentários, likes, inscrições e demais funcionalidades de fases posteriores; interface de vídeo no frontend (o enunciado do desafio mantém `next-frontend/` fora desta fase).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (módulo `videos`, worker, `compose.yaml`, migration)

**Deferred subprojects:** `next-frontend/` — interface de upload/reprodução fica para uma fase futura; o contrato HTTP é publicado via OpenAPI.

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto and Fase 02 — Cadastro, Login e Gerenciamento de Conta (canal 1:1 por usuário, JWT global, filtro de exceções de domínio).

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, login e gerenciamento de conta — entrega `users`, `channels`, JWT guard global, filtro de erros, throttling.
- **Phase 04:** Gerenciamento de Vídeos e Canal — consome a entidade de vídeo criada aqui.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ on Redis) | `@nestjs/bullmq@^11.0.5`, `bullmq@^5.x` |
| phase-03-videos/TD-02 | phase | Cross-layer | Large-File Upload Strategy (10GB) | decided | C (S3 multipart upload, presigned parts) | — |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Integration and Key Layout | decided | A (AWS SDK v3, single bucket, per-video keys) | `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x` |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Execution Model and FFmpeg Integration | decided | A (same codebase, separate worker container, spawn on presigned URL) | `ffmpeg` (system binaries) |
| phase-03-videos/TD-05 | phase | Backend | Unique Public Video Identifier (URL) | decided | B (11-char random `public_id`, unique index) | — |
| phase-03-videos/TD-06 | phase | Cross-layer | Streaming and Download Delivery | decided | B (302 to presigned GET; storage serves Range) | — |
| phase-03-videos/TD-07 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | A (draft → processing → ready or failed) | — |
| phase-03-videos/TD-08 | phase | Cross-layer | Upload Completion Trigger | decided | A (client-confirmed complete endpoint) | — |
| phase-03-videos/TD-09 | phase | Backend | Upload Limits and Policies | decided | A (fixed policy: 10 GiB, 100 MiB parts) | — |
| phase-03-videos/TD-10 | phase | Backend | Test Strategy for Queue, Storage and Worker | decided | A (real Compose services; in-process worker in e2e) | — |
| phase-03-videos/TD-11 | phase | Repo-wide | Docker Compose Topology and Environment Contract | decided | A (pinned `bitnamilegacy/minio` + Redis + worker service) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)
- openapi-docs-nestjs — `docs/decisions/technical-decisions-openapi-docs-nestjs.md` (scope_type: ad-hoc, `related_phases: []`; correlator-confirmed: OpenAPI contract for the new endpoints)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-09 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-10 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ on Redis — lowest-friction fit for NestJS 11 (official `@nestjs/bullmq`), gives retries/backoff/idempotent `jobId` out of the box, and lets the worker be a second container of the same codebase sharing only Redis.

**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^5.x`

### phase-03-videos/TD-02

**Recommendation:** S3 multipart upload with presigned part URLs, orchestrated by the API — the only option that keeps the API off the data path and clears the 5 GiB single-PUT ceiling (10GB needs multipart; parts 5 MiB–5 GiB, ≤ 10,000). Handshake: init (draft row + `CreateMultipartUpload` + presigned `UploadPart` URLs) → client uploads parts straight to storage and collects `ETag`s → complete (or abort). Orphan parts handled by the abort endpoint and a storage lifecycle rule.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** AWS SDK v3, one bucket, keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`. Two S3 clients: an internal one (`S3_ENDPOINT`, e.g. `http://minio:9000`) for server-side calls and a presigning one whose endpoint is `S3_PUBLIC_ENDPOINT` (the host is part of the SigV4 signature). Set `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'`.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-04

**Recommendation:** Same codebase, second entrypoint/container (`video-worker`, NestJS standalone application context registering only the BullMQ `@Processor`), `ffmpeg` installed in the image and invoked with `child_process.spawn` (argument array) against a presigned GET URL so no 10GB local copy is needed. Thumbnail: seek to 10% of the duration (≥ 1s when the video is long enough, otherwise frame 0), scale to max 1280px width, JPEG; metadata via `ffprobe -print_format json -show_format -show_streams`.

**Note:** Metadata persisted by the worker (resolves validation AMB-3): typed columns `duration_seconds` (numeric) and `size_bytes` (bigint), plus a `metadata` jsonb column with `format` (container name), `bit_rate`, `video` (`codec`, `width`, `height`, `frame_rate`) and `audio` (`codec`, `channels`, `sample_rate`) as reported by `ffprobe`. The thumbnail is stored at `videos/{videoId}/thumbnail.jpg` and its key persisted in `thumbnail_key`.

**Libraries:** `ffmpeg` (system binaries `ffmpeg`/`ffprobe` installed in the image via apt; not an npm package)

### phase-03-videos/TD-05

**Recommendation:** Separate `public_id` — 11-char URL-safe random string (8 random bytes, base64url) with a unique index and bounded retry on conflict (`23505`); generated at draft time, independent of the primary key.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** The API authorizes and `302`-redirects to a short-lived presigned GET URL; storage natively serves `Range` (`206`). `GET /videos/{publicId}/stream` redirects inline; `GET /videos/{publicId}/download` redirects with `ResponseContentDisposition: attachment`. The stable shareable URL is the API URL, not a storage URL.

**Note:** Access rules (resolves validation AMB-2): `init`, part-URL refresh, `complete`, `abort` and `GET /videos/{publicId}/status` are owner-only (authenticated, video belongs to the caller's channel); `GET /videos/{publicId}`, `stream`, `download` and `thumbnail` of a `ready` video are public (`@Public()`, anonymous users watch freely) — equivalent to link-only/unlisted access — and answer `404 VIDEO_NOT_FOUND` for any non-`ready` video (the global JWT guard does not populate the user on `@Public()` routes, so owner polling uses the dedicated `/status` route). Visibility (public vs unlisted) and the draft → publication flow are Phase 04 capabilities and are layered on top of this rule without changing the URL.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Four states — `draft` (created at init; upload in progress or awaiting completion) → `processing` (upload completed, job enqueued) → `ready` (duration, metadata and thumbnail stored) | `failed` (final failure with `failure_reason`). BullMQ retries 3 times with exponential backoff (5s base); only after the last attempt is the row set to `failed`. Worker transitions are guarded (`WHERE status = 'processing'`) and the job uses `jobId = video-{videoId}`, so replays are idempotent.

**Note:** Draft title (resolves validation AMB-1): `POST /videos` accepts an optional `title` (max 100 chars); when omitted it defaults to the file name without extension trimmed to 100 chars. Editing the title is Phase 04. Stale `draft` rows are not purged in this phase (recorded in `## Non-UI / Deferred Capabilities`).

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Client-confirmed `POST /videos/{publicId}/upload/complete` with the part list (`PartNumber` + `ETag`); the API calls `CompleteMultipartUpload`, verifies the final size with `HeadObject` against the 10 GiB limit (deleting the object and failing the request when exceeded), moves the video to `processing` and enqueues the job.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Server-chosen fixed policy: max size 10 GiB (`10 * 1024^3` bytes); part size 100 MiB (10 GiB → 103 parts); presigned part URLs valid 6 hours; declared content types `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`; real media validation in the worker (`ffprobe` failure → `failed`). Values come from env (Joi-validated) in a `storage`/`videos` config namespace.

**Note:** Cleanup scope (resolves validation AMB-4): an explicit `DELETE /videos/{publicId}/upload` aborts the multipart upload and removes the draft; the storage bucket also gets a lifecycle rule aborting incomplete multipart uploads after 1 day. Rate-limit policy (resolves validation ICC-1, refining `phase-02-auth/TD-08`, which is not superseded): upload-orchestration routes use `@Throttle({ default: { limit: 60, ttl: 60000 } })`; public read routes (`GET /videos/{publicId}`, `stream`, `download`, `thumbnail`) and the owner `status` route use `@Throttle({ default: { limit: 120, ttl: 60000 } })`; the global 10/min default stays for auth routes.

**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Run against the Compose services (real MinIO, Redis, `ffmpeg`); unit tests mock collaborators, integration tests hit real MinIO/Redis/PostgreSQL, e2e boots `AppModule` plus the worker processor in the same Jest process and drives init → part upload → complete → `ready` → stream `206`. Test media is generated with `ffmpeg lavfi` (`testsrc`), no binary fixtures; per-run bucket prefixes and queue cleanup keep tests isolated.

**Note:** Serial test execution (resolves validation IC-1): the `test` npm script becomes `jest --runInBand` so DB-backed suites never run in parallel workers (`test:integration` keeps `--runInBand`); `cleanAllTables` is extended with the new `videos` table.

**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** Pinned `bitnamilegacy/minio:2025.7.23-debian-12-r5` (real MinIO — the `minio/minio` Docker Hub repository no longer exists) + `redis:7-alpine` (AOF on, `maxmemory-policy noeviction`) + `video-worker` built from the API image with `ffmpeg`. Env keys: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `REDIS_HOST`, `REDIS_PORT` plus the TD-09 limits; the storage choice stays behind the `S3_*` contract so the image (or AWS S3) can change without code changes.

**Note:** Environment hygiene (resolves validation DG-1): `.env.example` quotes the whole `MAIL_FROM` value so `docker compose` can parse it; new keys (`S3_*`, `REDIS_*`, upload limits) are added to `.env.example`, `env.validation.ts` and the config namespaces together.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; the global JWT guard (`APP_GUARD`) is the effective access-control mechanism.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — preserves `class-validator` decisions; the CLI plugin with `classValidatorShim: true` infers schemas from existing decorators, keeping boilerplate low.

**Libraries:** `@nestjs/swagger`

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Runtime UI + exported `openapi.json`) — the exported `nestjs-project/openapi.json` is the contract consumed by the frontend; every controller documents its operations and reuses `ApiErrorEnvelope`.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; schema changes only through TypeORM CLI migrations in `src/database/migrations/`. _(from phase 01)_
- Services throw domain exceptions (`DomainException` subclasses carrying `errorCode` + `httpStatus`); `DomainExceptionFilter` maps them to `{ statusCode, error, message }`; services never throw NestJS HTTP exceptions. _(from phase 02)_
- `main.ts` registers a global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) and the domain/validation exception filters; e2e tests reproduce this config manually in `beforeAll`. _(from phase 02)_
- The JWT guard is global (`APP_GUARD`); every route is protected unless it opts out with `@Public()`; the authenticated principal is read with `@CurrentUser()` (`JwtPayload = { sub, email }`, `sub` = user id). _(from phase 02)_
- Entities use `@Entity('table_name')`, UUID primary keys, `snake_case` columns, `created_at`/`updated_at`; each user owns exactly one channel (`channels.user_id` unique, 1:1). _(from phase 02)_
- Multi-step writes use `dataSource.transaction(...)` inside the owning service; modules register their entities with `TypeOrmModule.forFeature([...])`. _(from phase 02)_
- Every controller carries `@ApiTags`, `@ApiOperation`, `@ApiResponse` for success and each predictable error (error schema `ApiErrorEnvelope`), `@ApiBearerAuth('access-token')` on protected routes; `nestjs-project/openapi.json` is regenerated with `npm run openapi:export`. _(from phase 02 / openapi-docs-nestjs)_
- Test suffixes: `*.spec.ts` (unit, mocks), `*.integration-spec.ts` (real DB/services, `--runInBand`), `*.e2e-spec.ts` (supertest in `test/`); `cleanAllTables` in `src/test/create-test-data-source.ts` wipes tables between tests. _(from phase 02)_
- Docker: services are addressed by Compose service name (`db`, `mailpit`), never `localhost`. _(from phase 01/02 — root `CLAUDE.md`)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` was not initialized in Phase 02 (later delivered by `phase-02-auth-frontend`); informational only for this phase |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| Purga de rascunhos de upload abandonados (linhas `draft` obsoletas) | deferred | Not a Phase 03 bullet; the explicit abort endpoint and the storage lifecycle rule cover orphan parts, stale rows are handled with the draft → publication flow in Phase 04 (validation AMB-4). | phase-03-videos/TD-07, phase-03-videos/TD-09 |

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` — Feature Implementation Checklist)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — no controller unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard | E2E (+ Unit if complex internal logic) |
| Exception Filter | Unit + E2E |

### next-frontend

_Deferred subproject — testing requirements will be defined when the video UI phase starts._
