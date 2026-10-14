# Architecture — AI Shorts Automation Platform

> Status: living document. Update it whenever a boundary, contract or deployment
> topology changes.

## 1. Goals and non-goals

**Goals**

- Produce *original* vertical short-form video end-to-end, from idea to published
  YouTube Short, with a human able to intervene at every step.
- Be safe by default: nothing reaches YouTube without passing quality control,
  content safety, similarity checks, cost limits and (by default) a human approval.
- Be provider-agnostic. Every external AI/cloud dependency sits behind an interface
  so it can be swapped without touching business logic.
- Be operable: structured logs, health checks, cost dashboards, a kill switch.

**Non-goals**

- Re-uploading, scraping or "borrowing" other creators' content. The platform has
  no download-from-YouTube/TikTok capability by design (see `docs/security.md`).
- Artificial engagement (views, likes, comments, bot interaction). Not implemented,
  not planned.

## 2. Bird's eye view

```
                       ┌────────────────────────────────────────────┐
                       │            apps/web (Next.js)              │
                       │  Dashboard · Ideas · Videos · Publishing   │
                       │  Analytics · Providers · Settings · Logs   │
                       └───────────────┬────────────────────────────┘
                                       │ HTTPS, httpOnly session cookie
                                       │ (Next server components proxy → API)
                       ┌───────────────▼────────────────────────────┐
                       │            apps/api (NestJS)               │
                       │                                            │
                       │  HTTP layer  → controllers, guards, DTOs   │
                       │  Domain      → content engine, pipeline,   │
                       │                 QC, safety, cost, sched.   │
                       │  Ports       → provider interfaces         │
                       └───┬───────────────┬───────────────┬────────┘
                           │               │               │
              ┌────────────▼───┐   ┌───────▼──────┐  ┌─────▼─────────┐
              │  Adapters      │   │  PostgreSQL  │  │  Object store │
              │  LLM / Video / │   │  (Prisma)    │  │  GCS or local │
              │  Voice / TTS / │   └──────────────┘  └───────────────┘
              │  YouTube / GCS │
              └────────────────┘
                           ▲
                           │ push (HTTP + OIDC)
              ┌────────────┴──────────────┐
              │  Cloud Tasks / in-process │  ← QueueProvider port
              └────────────┬──────────────┘
                           │ cron
              ┌────────────┴──────────────┐
              │  Cloud Scheduler          │
              └───────────────────────────┘
```

## 3. Layering rules (Clean Architecture, pragmatic)

The API is a NestJS application, but the dependency direction is enforced by
convention *and* by lint rules:

| Layer | Location | May depend on |
| --- | --- | --- |
| **Contracts** | `packages/contracts` | nothing (pure types + zod schemas) |
| **Ports** | `apps/api/src/providers/**/*.interface.ts` | contracts |
| **Domain services** | `apps/api/src/modules/**` | contracts, ports, Prisma repositories |
| **Adapters** | `apps/api/src/providers/**/*.provider.ts` | contracts, ports, vendor SDKs |
| **HTTP** | `*.controller.ts` | domain services, contracts |

Concrete rule of thumb: **no domain service ever imports a vendor SDK, and no
adapter ever imports a domain service.** Wiring happens exactly once, in
`ProvidersModule`, via factory providers keyed by injection tokens.

## 4. Component inventory

### 4.1 Content Engine (`modules/content`, `modules/ideas`, `modules/scripts`)

Responsible for turning a niche + character library into an original, non-repetitive
production brief.

```
generateIdea()
  → load niche config + character library
  → load "recent fingerprints" (last N ideas/scripts/titles/prompts)
  → ask LLMProvider for K candidate ideas, with the fingerprints as negative context
  → for each candidate: SafetyService.evaluate() → SimilarityService.check()
  → first candidate that is ALLOW + below all similarity thresholds wins
  → persist ContentIdea (+ its fingerprints)
  → if all candidates rejected: retry with a stronger diversification instruction,
    up to IDEA_MAX_ATTEMPTS, then fail loudly
```

The same pattern (generate → safety → similarity → persist) applies to scripts.

### 4.2 Similarity / anti-spam (`modules/similarity`)

Pure, dependency-free functions, heavily unit tested:

- `normalize(text)` — lowercase, strip punctuation/diacritics, collapse whitespace,
  remove stopwords.
- `shingles(text, k)` — word k-grams.
- `jaccard(a, b)` — set similarity over shingles. Used for scripts and scene prompts.
- `trigramCosine(a, b)` — character trigram cosine. Robust for short strings (titles).
- `simhash64(text)` — 64-bit SimHash stored on every record so a cheap
  Hamming-distance pre-filter runs in SQL before the expensive comparison.

Thresholds are configuration, not constants (`SIMILARITY_*` env vars).

### 4.3 Character library (`modules/characters`)

A `Character` row is the single source of truth for a recurring figure. Every scene
prompt is rendered from a template that always injects the character's
`promptDescription`, `appearance`, `outfit` and `visualStyle`, plus a stable
`seed` so the video provider produces a consistent look. Characters are versioned:
editing a character creates a new `promptRevision` so old videos remain reproducible.

### 4.4 Pipeline (`modules/pipeline`)

The video lifecycle is an explicit state machine. `VideoStatus` is the state;
each transition is performed by a `PipelineStep`:

```
CREATED → SCRIPT_GENERATED → SCENES_PLANNED → GENERATING → GENERATED
        → ASSEMBLING → QUALITY_CHECK → READY_FOR_REVIEW → APPROVED
        → QUEUED → UPLOADING → PUBLISHED
                                     ↘ FAILED (from any state)
                                     ↘ REJECTED (from READY_FOR_REVIEW)
                                     ↘ CANCELLED (operator action)
```

Properties every step must satisfy:

1. **Idempotent.** Re-running a step that already produced its output is a no-op.
   Enforced by checking for the output artifact first (e.g. "does this scene already
   have a downloaded asset?").
2. **Resumable.** State lives in Postgres, never in memory. A crashed Cloud Run
   instance loses nothing.
3. **Guarded.** `EmergencyStop`, `CostGuard` and upload quotas are checked before
   any step that spends money or publishes.

`PipelineOrchestrator.advance(videoId)` looks up the current status, finds the
registered step for it, runs it inside a transactional envelope, records timings and
enqueues the next job. That is the *only* place that mutates `Video.status`.

### 4.5 Media (`modules/media`)

- `FfmpegRunner` (`src/infrastructure/ffmpeg/`) — the **only** place in the
  codebase allowed to spawn a process, enforced by a lint rule. Commands are built
  as argument arrays (never a shell string), with a hard timeout and bounded
  stderr. It lives in `infrastructure/` rather than `modules/` because both the
  media pipeline and the mock video provider need it, and an adapter must not
  depend on a domain module.
- `SubtitleService` — word/segment timing → styled ASS/SRT, vertical-safe margins.
- `AssemblyService` — concat scenes, mix voice + music, loudness-normalise (EBU R128
  via `loudnorm`), burn subtitles, encode H.264/AAC 1080×1920.
- `QualityControlService` — runs `ffprobe` plus the database checks
  and returns a structured report.

### 4.6 YouTube (`modules/youtube`)

- OAuth 2.0 authorization-code flow with PKCE-style `state` nonce, offline access.
- Refresh tokens are encrypted at rest (AES-256-GCM, key from Secret Manager).
- Uploads use the **resumable** protocol so a 100 MB short survives a dropped
  connection and can be retried without re-sending bytes already accepted.
- Every publish passes through `PublishGuard`: emergency stop, `AUTO_PUBLISH`,
  `REQUIRE_APPROVAL`, daily/monthly quotas, QC verdict, safety verdict.

### 4.7 Jobs & queue (`modules/jobs`, `providers/queue`)

Long work never runs inside a user-facing HTTP request. Two related models:

- **`Job`** — the *transport/worker* record: type, payload, status, attempts,
  `runAfter`, `idempotencyKey`, timings, last error. This is what the queue drives.
- **`GenerationJob` / `UploadJob`** — *domain* records that outlive a single attempt:
  provider job ids, per-scene progress, cost attribution, resumable upload session,
  resulting YouTube video id. They are what the dashboard shows.

Claiming a job is a single conditional `UPDATE ... WHERE status = 'QUEUED'`, so two
workers can never run the same job.

### 4.8 Cost control (`modules/cost`)

Every adapter call that costs money goes through `MeteredCall`, which writes a
`CostRecord` (provider, model, operation, units, estimated + actual cost). `CostGuard`
is consulted *before* the call and refuses when the rolling daily/monthly budget is
exhausted; exceeding a limit flips the emergency stop and raises an admin alert.

### 4.9 Analytics & performance analysis (`modules/analytics`)

A scheduled job pulls public statistics for published videos and appends an immutable
`AnalyticsSnapshot`. Derived metrics (views/hour, like rate, comment rate, a weighted
performance score) are computed from consecutive snapshots. The AI analysis module
summarises *patterns* across high performers — hook shape, length band, character mix,
posting hour — and feeds them back as guidance for future idea generation. It never
copies a specific successful video.

## 5. Data model

See `apps/api/prisma/schema.prisma` for the authoritative definition. Entity map:

```
User ──< Session
Channel ──1 OAuthCredential
Channel ──< Video ──< VideoScene ──1 Asset
                 │
                 ├──1 Script ──1 ContentIdea
                 ├──< Asset            (voice, music, final render, thumbnail)
                 ├──< GenerationJob
                 ├──< UploadJob
                 ├──< AnalyticsSnapshot
                 ├──< QualityReport
                 └──< CostRecord

Character ──< ContentIdea (m:n via IdeaCharacter)
Schedule ──< ScheduleSlot
ProviderConfig, SystemSetting, SystemLog, Job, AuditLog
```

Everything with a lifecycle uses a Postgres enum. Money is stored as integer
**micro-USD** (`1_000_000 = $1`) to avoid floating point drift.

## 6. Deployment topology (Google Cloud)

| Concern | Service |
| --- | --- |
| API + worker (same image, `ROLE` env) | Cloud Run |
| Dashboard | Cloud Run |
| Database | Cloud SQL for PostgreSQL (private IP + connector) |
| Objects (renders, scenes, voice) | Cloud Storage |
| Secrets | Secret Manager |
| Queue | Cloud Tasks → OIDC-authenticated `/internal/tasks/*` |
| Cron | Cloud Scheduler → `/internal/cron/*` |
| Images | Artifact Registry |
| IaC | Terraform (`infra/terraform`) |

The worker is the *same container* as the API; it simply exposes the internal task
endpoints, which are locked to Cloud Tasks' service account via OIDC. This keeps one
build artifact and one migration path.

## 7. Security model

Summarised here, detailed in `docs/security.md`.

- No secrets in the repo. `.env` is git-ignored, `.env.example` documents every key.
- Session auth: opaque session id in an httpOnly, SameSite=Lax, Secure cookie;
  server-side session records with absolute + idle expiry; scrypt password hashing.
- Mutating requests require a double-submit CSRF token.
- Internal task/cron endpoints accept only OIDC (prod) or a shared secret (local).
- OAuth refresh tokens encrypted with AES-256-GCM before they touch the database.
- Structured logging with a redaction list; secrets never reach the log stream.
- Rate limiting on all admin and auth endpoints.

## 8. Failure handling

- Every outbound call: timeout → bounded retries with exponential backoff and full
  jitter → typed error. Non-retryable classes (4xx other than 408/429) fail fast.
- Every job: `maxAttempts`, then a terminal `FAILED` with a human-readable reason
  and the provider's correlation id.
- No unbounded loops anywhere; every polling wait has a deadline.
- Partial failures degrade rather than crash: a missing analytics provider marks
  System Health `WARNING`, it does not stop generation.

## 9. Testing strategy

| Level | What | How |
| --- | --- | --- |
| Unit | similarity, safety, cost math, retry, prompt building, subtitles, QC rules, scheduling | pure functions, no I/O |
| Adapter | each provider adapter | vendor SDK/HTTP mocked; **never** a real paid call |
| Service | content engine, pipeline steps, publish guard | in-memory fakes for ports |
| API | controllers, guards, validation | Nest testing module + supertest |

`DRY_RUN=true` plus the mock providers make the whole pipeline runnable with zero
API keys, which is also what CI uses. The test bootstrap replaces `fetch` with a
function that throws, so a test that would reach the network fails loudly instead
of silently calling a paid API.

One test deserves special mention: `test/e2e/app-boot.e2e-spec.ts` boots the real
module graph against a Prisma double. It is what catches a circular import, an
unregistered provider, an unbound token, two pipeline steps claiming the same
status, or a guard that fails open — none of which a unit test can see.
