---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-15T15:34:02-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-15T15:34:02-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-15T15:12:21-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-15T15:34:02-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "`npm test` runs integration suites in parallel but they require --runInBand"
    resolved_by: phase-03-videos/TD-10
  - id: AMB-1
    status: resolved
    summary: "Where does the draft title come from at upload start?"
    resolved_by: phase-03-videos/TD-07
  - id: AMB-2
    status: resolved
    summary: "Who may stream/download/see a video; boundary with Phase 04 visibility"
    resolved_by: phase-03-videos/TD-06
  - id: AMB-3
    status: resolved
    summary: "Which metadata is extracted by the worker is not enumerated"
    resolved_by: phase-03-videos/TD-04
  - id: AMB-4
    status: resolved
    summary: "Abandoned drafts and orphan multipart parts: what cleanup is in scope"
    resolved_by: phase-03-videos/TD-09
  - id: DG-1
    status: resolved
    summary: ".env.example MAIL_FROM line cannot be parsed by Docker Compose"
    resolved_by: phase-03-videos/TD-11
  - id: ICC-1
    status: resolved
    summary: "Global 10/min ThrottlerGuard (phase-02-auth/TD-08) hits video endpoints"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Message Queue Technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Large-File Upload Strategy (10GB)"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Object Storage Integration and Key Layout"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Video Worker Execution Model and FFmpeg"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Unique Public Video Identifier (URL)"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Video Status Lifecycle and Failure Handling"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Upload Completion Trigger"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Upload Limits and Policies"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Test Strategy for Queue, Storage and Worker"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Docker Compose Topology and Environment Contract"
    resolved_by: phase-03-videos/TD-11
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

_Cycle 1 — `/plan-validate` found 18 open issues (1 IC, 4 AMB, 1 DG, 1 ICC, 11 OQ); `/plan-resolve` applied the decisions and clarifications below; cycle 2 `/plan-validate` re-ran every check against the updated `context.md` and found no new issue._

- **IC-1** _(resolved_by phase-03-videos/TD-10)_ — `npm test` must run serially: the `test` script becomes `jest --runInBand` (observed baseline failure with parallel workers sharing one database).
- **AMB-1** _(resolved_by phase-03-videos/TD-07)_ — Draft title: optional `title` at init (max 100 chars), default = file name without extension; edition is Phase 04.
- **AMB-2** _(resolved_by phase-03-videos/TD-06)_ — Access rules: owner-only for init/complete/abort and for details of non-`ready` videos; stream/download of `ready` videos public by link; visibility is Phase 04.
- **AMB-3** _(resolved_by phase-03-videos/TD-04)_ — Persisted metadata fixed: `duration_seconds`, `size_bytes`, `metadata` jsonb (format, bit_rate, video, audio), `thumbnail_key`.
- **AMB-4** _(resolved_by phase-03-videos/TD-09)_ — In scope: abort endpoint + storage lifecycle rule (1 day); stale `draft` row purge recorded as deferred in `## Non-UI / Deferred Capabilities`.
- **DG-1** _(resolved_by phase-03-videos/TD-11)_ — `.env.example` quotes the whole `MAIL_FROM` value in the Compose/env SI.
- **ICC-1** _(resolved_by phase-03-videos/TD-09)_ — Per-route `@Throttle` policies for video routes (60/min orchestration, 120/min public reads); `phase-02-auth/TD-08` is refined, not superseded.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — decided A (BullMQ on Redis).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — decided C (S3 multipart, presigned parts).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — decided A (AWS SDK v3, single bucket, per-video keys).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — decided A (same codebase, separate worker container, `spawn` on presigned URL).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — decided B (11-char random `public_id`).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — decided B (302 to presigned GET; storage serves Range).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — decided A (draft → processing → ready or failed).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — decided A (client-confirmed complete endpoint).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — decided A (fixed policy: 10 GiB, 100 MiB parts, 6h URLs).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — decided A (real Compose services; in-process worker in e2e).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — decided A (pinned `bitnamilegacy/minio` + Redis + worker service).
