# Operations handbook

A production-grade platform for generating **original** vertical short-form video
end to end — idea, script, scenes, voice, render, quality control, metadata — and
publishing it to YouTube on a schedule, with a human able to intervene at every step.

It ships **safe by default**: mock providers, no uploads, mandatory human approval.
Nothing costs money or reaches YouTube until you deliberately turn that on.

---

## Contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [Installation](#4-installation)
5. [Environment variables](#5-environment-variables)
6. [Google Cloud setup](#6-google-cloud-setup)
7. [YouTube OAuth setup](#7-youtube-oauth-setup)
8. [Provider setup](#8-provider-setup)
9. [Local development](#9-local-development)
10. [Database](#10-database)
11. [Deployment](#11-deployment)
12. [Scheduler](#12-scheduler)
13. [Monitoring](#13-monitoring)
14. [Troubleshooting](#14-troubleshooting)
15. [Security](#15-security)
16. [Cost control](#16-cost-control)
17. [Going live safely](#17-going-live-safely)

---

## 1. What it does

```
Idea → Script → Scene plan → Video generation → Voice → Music
     → Assembly → Subtitles → Quality control → Metadata
     → Approval → Scheduling → Upload → Analytics → Insights ─┐
       ▲                                                       │
       └───────────────────────────────────────────────────────┘
```

Each stage is an explicit state, persisted in Postgres. A crash resumes where it
left off; a retry never repeats work that already succeeded.

**What it will not do**, by design:

- Download, re-upload or "remix" anyone else's video. There is no such capability
  in the code — see the `YouTubeProvider` interface, which can only publish to a
  channel you own.
- Generate artificial views, likes, comments or any other engagement.
- Publish anything that has not passed quality control, the content-safety layer
  and the originality check.

### Safety features

| Control | Default | Effect |
| --- | --- | --- |
| `DRY_RUN` | `true` | Mock providers everywhere. No spend, no uploads. |
| `REQUIRE_APPROVAL` | `true` | A person must approve every video. |
| `AUTO_PUBLISH` | `false` | Uploads stay private even when approved. |
| `MAX_DAILY_UPLOADS` | `3` | Hard cap, enforced before every upload. |
| `MAX_DAILY_COST` | `10` USD | Hard cap; exceeding it pauses generation. |
| Emergency stop | off | One click halts everything and cancels queued work. |

---

## 2. Architecture

Full detail in **[docs/architecture.md](architecture.md)**. In brief:

- **`apps/api`** — NestJS. Domain logic, the pipeline state machine, all guards.
- **`apps/web`** — Next.js operator console.
- **`packages/contracts`** — types, enums and zod schemas shared by both.

Every external dependency sits behind a port (`LLMProvider`, `VideoProvider`,
`VoiceProvider`, `StorageProvider`, `YouTubeProvider`, `QueueProvider`). Adapters
are bound in exactly one place, `ProvidersModule`, from configuration. No domain
service imports a vendor SDK; a lint rule enforces it.

---

## 3. Prerequisites

| | Version | Needed for |
| --- | --- | --- |
| Node.js | 20.11+ (22 LTS recommended) | everything |
| Docker | any recent | PostgreSQL, container builds |
| ffmpeg + ffprobe | 6+ | rendering. **Required** — the pipeline cannot run without it |
| Google Cloud SDK | latest | deployment only |
| Terraform | 1.6+ | deployment only |

`ffmpeg` is a hard requirement. If you would rather not install it on your host,
run the whole stack in containers (`make docker-up`) — the API image includes it.

---

## 4. Installation

```bash
git clone <your-repository-url> ai-shorts-platform
cd ai-shorts-platform
make setup
```

`make setup` installs dependencies, generates a `.env` with fresh secrets, starts
PostgreSQL, applies migrations and seeds example data. It prints the generated
admin password — **save it**.

Then:

```bash
make dev
```

- Dashboard → <http://localhost:3000>
- API → <http://localhost:3001>
- API docs (non-production only) → <http://localhost:3001/api/docs>

Sign in with `admin@example.com` and the password `make setup` printed.

<details>
<summary>Manual setup, if you prefer not to use make</summary>

```bash
npm ci
npm run build --workspace @shorts/contracts
npm run db:generate

cp .env.example .env
# Generate and paste these into .env:
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -hex 24      # INTERNAL_API_KEY
# Set BOOTSTRAP_ADMIN_PASSWORD to something at least 12 characters.

# The Prisma CLI reads .env from the schema's own directory:
ln -sf ../../.env apps/api/.env

docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```
</details>

---

## 5. Environment variables

Every variable is documented in **[`.env.example`](../.env.example)**. The API
validates the whole environment at boot and refuses to start on a bad value,
naming the variable and what is wrong with it.

The ones that matter most:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | 32 bytes base64. Signs operator sessions |
| `ENCRYPTION_KEY` | 32 bytes base64. Encrypts OAuth refresh tokens at rest |
| `INTERNAL_API_KEY` | Protects `/internal/*` in local development |
| `DRY_RUN` | `true` forces mock providers everywhere |
| `LLM_PROVIDER` / `VIDEO_PROVIDER` / `VOICE_PROVIDER` | which adapter to use |
| `MAX_DAILY_COST` / `MAX_MONTHLY_COST` | spend caps in USD |
| `TIMEZONE` | drives schedules and quota windows |

> **Rotating `ENCRYPTION_KEY` invalidates every stored OAuth token.** Channels must
> be reconnected. See [docs/security.md](security.md#key-rotation).

---

## 6. Google Cloud setup

Only needed for deployment. Step-by-step in
**[docs/cloud-deployment.md](cloud-deployment.md)**.

```bash
gcloud projects create my-shorts-project
gcloud config set project my-shorts-project
gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com artifactregistry.googleapis.com storage.googleapis.com

cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # edit it
terraform init -backend-config="bucket=my-tfstate-bucket"
terraform apply
```

Terraform prints exactly what to do next, including which secrets to populate.

---

## 7. YouTube OAuth setup

Full walkthrough with screenshots of each console field in
**[docs/youtube-setup.md](youtube-setup.md)**. Summary:

1. Enable **YouTube Data API v3** in your Google Cloud project.
2. Configure the **Google Auth Platform** (formerly "OAuth consent screen"):
   External, and add yourself as a test user while the app is unverified.
3. Create an **OAuth client ID** of type *Web application*.
4. Add the redirect URI:
   - local: `http://localhost:3001/api/v1/youtube/oauth/callback`
   - production: `https://<api-url>/api/v1/youtube/oauth/callback`
5. Put the client id and secret in `.env` (or Secret Manager) and set
   `YOUTUBE_PROVIDER=google`.
6. Dashboard → **Channels** → *Connect a channel*.

Scopes requested are the minimum needed: `youtube.upload`, `youtube.readonly`,
`yt-analytics.readonly`. Nothing that could touch another account is requested.

> The platform never sees or stores a Google password. It stores an encrypted
> refresh token, which you can revoke at any time from your Google account.

---

## 8. Provider setup

See **[docs/providers.md](providers.md)** for the interface each adapter
implements and how to add your own.

```bash
LLM_PROVIDER=anthropic     # mock | anthropic | openai
VIDEO_PROVIDER=replicate   # mock | replicate | fal
VOICE_PROVIDER=elevenlabs  # mock | elevenlabs | openai
STORAGE_PROVIDER=gcs       # local | gcs
YOUTUBE_PROVIDER=google    # mock | google
QUEUE_PROVIDER=cloudtasks  # inmemory | cloudtasks
```

Selecting a real provider without its API key fails at boot with a message
naming the missing variable. While `DRY_RUN=true`, the paid providers are
overridden with mocks regardless of what is configured — the Providers page shows
this explicitly as *forced mock by DRY_RUN*.

---

## 9. Local development

```bash
make dev          # API + dashboard
make test         # 300+ unit and integration tests
make verify       # format, lint, typecheck, test — what CI runs
make docker-up    # the whole stack in containers, ffmpeg included
```

The mock providers render **real** MP4 and audio via ffmpeg, so a dry run
exercises the actual assembly, subtitle, loudness and quality-control code — it
does not bypass the pipeline.

---

## 10. Database

Prisma with PostgreSQL. Schema: [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma).

```bash
npm run db:migrate   # create and apply a migration (development)
npm run db:deploy    # apply existing migrations (production)
npm run db:seed      # example data; safe to re-run
npm run db:studio    # browse the data
npm run db:reset     # drop, recreate, re-seed — destroys everything
```

Never edit the database by hand; every change goes through a migration.

---

## 11. Deployment

**[docs/cloud-deployment.md](cloud-deployment.md)** covers this properly.

```bash
gcloud builds submit --config infra/cloudbuild/cloudbuild.yaml \
  --substitutions _REGION=europe-west1,_ENVIRONMENT=prod
```

The pipeline lints, typechecks and tests before building; builds both images;
**applies migrations before deploying**; then smoke-tests the new revision.

The API and worker are the same image with a different `APP_ROLE`, so there is
one artefact to build, scan and promote.

---

## 12. Scheduler

Create a schedule in the dashboard under **Schedules**: pick a channel, a
timezone, how many videos per day, and the slots (e.g. 09:00, 15:00, 20:00).

Each tick does the smallest useful thing:

1. Publishes an already-approved video if one is waiting and publishing is allowed.
2. Otherwise starts producing one, so a video exists by the next slot.

Slots are wall-clock times in the schedule's timezone, and daylight-saving
transitions are handled explicitly — a 09:00 slot fires at 09:00 local, year round.
A time that does not exist on a spring-forward day runs just after the transition
rather than being skipped.

Locally an in-process cron drives this. On Cloud Run, Cloud Scheduler calls
`/internal/cron/scheduler`; the in-process timer stands down automatically so the
two can never both run.

---

## 13. Monitoring

- **Dashboard → Health** — live probe of database, every provider, ffmpeg and the queue.
- **Dashboard → Logs** — application events, with secrets redacted before writing.
- **Dashboard → Job queue** — every job, its retry budget and its last error.
- `GET /liveness` — is the process up (no dependencies).
- `GET /readiness` — can this instance serve traffic (database only).

Logs are structured JSON in production, so Cloud Logging indexes the fields.

---

## 14. Troubleshooting

**The API will not start, complaining about the environment**
It is telling you exactly which variable is wrong. `SESSION_SECRET` and
`ENCRYPTION_KEY` must each decode to exactly 32 bytes: `openssl rand -base64 32`.

**Health shows `FFmpeg: ERROR`**
ffmpeg or ffprobe is not on `PATH`. Install it, set `FFMPEG_PATH` / `FFPROBE_PATH`,
or run in containers with `make docker-up`.

**Videos fail quality control on "Originality"**
The similarity layer found a near-duplicate. That is it working. Add characters,
give the idea generator different guidance, or raise the thresholds in
`SIMILARITY_*` if they are too strict for your niche.

**Idea generation fails with "Every generated idea was rejected"**
Same cause, at the idea stage. The error lists what was rejected and why.

**Publishing is blocked**
Open the video and read *Publish readiness* — it lists every blocker at once,
rather than making you fix them one at a time.

**Prisma: "Query Engine for runtime linux-…" not found**
The client was generated for a different platform than it is running on. The
schema already declares the needed `binaryTargets`; re-run `npm run db:generate`
and rebuild the image.

**Jobs stay QUEUED and never run**
The worker is not draining. Check `APP_ROLE` (`worker` or `all`) and
`QUEUE_PROVIDER`. With `cloudtasks`, verify Cloud Scheduler and Cloud Tasks can
reach `/internal/*` — they need the invoker service account.

**The dashboard cannot reach the API**
Check `API_INTERNAL_URL` (server-side) and that the API's `CORS_ALLOWED_ORIGINS`
contains the dashboard origin.

---

## 15. Security

Full treatment in **[docs/security.md](security.md)**.

- No secrets in the repository. `.env` is git-ignored; `.env.example` documents every key.
- Sessions are opaque tokens stored **hashed**; a database dump yields no usable sessions.
- Passwords use scrypt with per-password salts and tunable cost.
- Mutating requests require a double-submit CSRF token.
- OAuth refresh tokens are encrypted with AES-256-GCM before they touch the database.
- `/internal/*` accepts only OIDC (production) or a shared secret (local); a user
  session is never sufficient.
- Every log line and persisted log row passes through a redaction layer.
- ffmpeg is invoked with argument arrays and never a shell string.
- Storage keys are validated against traversal.
- Rate limiting is applied globally, with a tighter budget on authentication.

---

## 16. Cost control

Every paid call goes through one wrapper that checks the budget **before**
spending and records what was spent afterwards. There is no second path.

- **Dashboard → Dashboard** shows spend today and this month against the limits.
- Crossing a limit pauses generation and raises an admin alert.
- Cost per video and cost per *published* video are tracked separately — the
  second is the number that matters, since rejected videos still cost money.
- Money is stored as integer micro-USD, so thousands of sub-cent charges sum exactly.

Set `MAX_DAILY_COST` and `MAX_MONTHLY_COST` deliberately before leaving `DRY_RUN`.

---

## 17. Going live safely

The defaults exist because this system spends money and publishes in public.
Recommended order:

1. **Dry run.** `DRY_RUN=true`. Produce several videos end to end. Watch them in
   the dashboard. Confirm quality control behaves as you expect.
2. **Real providers, no uploads.** Set `DRY_RUN=false` with real API keys but
   `YOUTUBE_PROVIDER=mock`. Set a low `MAX_DAILY_COST`. Check what things actually cost.
3. **Real uploads, private.** `YOUTUBE_PROVIDER=google`, `AUTO_PUBLISH=false`.
   Videos upload as private. Review each on YouTube before making it public.
4. **Scheduled, still approved by hand.** Add a schedule. Keep
   `REQUIRE_APPROVAL=true`. Let it run for a week.
5. **Automated.** Only once steps 1-4 have been boring for a while: set
   `AUTO_PUBLISH=true` and approval mode to `AUTO`. Keep the upload and cost caps.

You can return to any earlier step instantly from the dashboard, and the
emergency stop halts everything at once.

---

## Licence and responsibility

You are responsible for what this platform publishes under your name. It is built
to produce original work and to make policy compliance the default, but it does
not remove your obligation to review what goes out, or to comply with the
[YouTube Terms of Service](https://www.youtube.com/t/terms) and the terms of every
AI provider you configure.
