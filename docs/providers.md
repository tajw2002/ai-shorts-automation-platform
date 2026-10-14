# Providers

Every external dependency sits behind an interface. This document explains the
contracts, which adapters ship, and how to add your own.

---

## 1. Why ports

Business logic never imports a vendor SDK. It asks for a token and receives
whatever configuration selected. That buys three concrete things:

- **The whole pipeline runs with no API keys.** Mock adapters render real MP4 and
  audio, so a dry run exercises assembly, subtitles, loudness and quality control
  rather than skipping them.
- **Switching vendors is a configuration change**, not a refactor.
- **`DRY_RUN` cannot be defeated by a stray variable.** The override lives in
  `AppConfig.providers`, so there is no `if (dryRun)` scattered through services.

A lint rule enforces the boundary: anything under `src/modules/**` that imports
`googleapis`, `openai`, `@anthropic-ai/sdk`, `@google-cloud/*`, or an adapter file
directly, fails the build.

---

## 2. Selecting adapters

```bash
LLM_PROVIDER=mock       # mock | anthropic | openai
VIDEO_PROVIDER=mock     # mock | replicate | fal
VOICE_PROVIDER=mock     # mock | elevenlabs | openai
STORAGE_PROVIDER=local  # local | gcs
YOUTUBE_PROVIDER=mock   # mock | google
QUEUE_PROVIDER=inmemory # inmemory | cloudtasks
```

Unknown values are rejected at boot by the environment schema, so a typo fails
loudly instead of silently falling back to a mock.

Selecting a real adapter without its key also fails at boot, naming the variable.

**While `DRY_RUN=true`**, the LLM, video, voice and YouTube ports are forced to
mocks regardless of configuration. Storage and queue are *not* — they cost nothing
per call, so a dry run keeps exercising the real code path. The Providers page
labels anything overridden as *forced mock by DRY_RUN*.

---

## 3. The ports

### `LLMProvider`

Domain-shaped rather than a bare `complete(prompt)`, so each adapter can use what
its vendor does best — structured outputs, tool use, JSON mode — while the content
engine only ever sees validated domain objects.

```ts
generateIdeas(input): Promise<ProviderResult<ContentIdeaDraft[]>>
generateScript(input): Promise<ProviderResult<ScriptDraft>>
generateMetadata(input): Promise<ProviderResult<VideoMetadataDraft>>
analyzePerformance(input): Promise<ProviderResult<PerformanceAnalysisResult>>
moderate(input): Promise<ProviderResult<SafetyAssessment>>
```

Prompt text is shared across adapters in `providers/llm/prompts/`, so switching
vendors does not silently change what the model is asked to do.

| Adapter | Notes |
| --- | --- |
| `mock` | Deterministic and varied. Seeded from its input, so tests can assert on content and the similarity layer gets genuinely distinguishable candidates. |
| `anthropic` | `messages.parse` with `zodOutputFormat`. A response either satisfies the schema or throws — there is no partial parsing. |
| `openai` | Responses API with a strict JSON schema from the same zod definitions. |

### `VideoProvider`

Explicitly a three-step handle/poll/download protocol, because generation is
asynchronous everywhere in this market. The provider job id is persisted **before**
polling begins, so a worker restart resumes polling rather than paying to generate
the same scene twice.

```ts
generateVideo(request): Promise<VideoGenerationHandle>
getGenerationStatus(providerJobId): Promise<VideoGenerationStatus>
downloadVideo(outputUrl): Promise<VideoDownload>   // streams; never buffers a clip
cancelGeneration?(providerJobId): Promise<void>
```

| Adapter | Notes |
| --- | --- |
| `mock` | Renders a real H.264 clip via ffmpeg, coloured deterministically from the prompt so scenes are visually distinct. |
| `replicate` | Verified against the Replicate HTTP API. Supports both the versioned and official-model routes, selected by the shape of `VIDEO_MODEL`. |
| `fal` | Uses the Replicate adapter with `VIDEO_PROVIDER_BASE_URL` pointed at it; the create/poll/download shape is close enough. |

Model inputs are **not** standardised across video models, and Replicate validates
them against the model's own schema before running, so a value outside it is
rejected. The adapter sends `prompt`, `aspect_ratio`, `duration`, `fps` and `seed`,
with `aspect_ratio` reduced to a label (`1080x1920` becomes `9:16`, never raw
pixels). Everything else is configuration:

- `VIDEO_INPUT_OVERRIDES` merges model-specific inputs over those defaults, and a
  `null` value removes one. `bytedance/seedance-1-lite`, for example, accepts only
  `fps` 24 and takes a `resolution`, so it needs `{"fps":24,"resolution":"480p"}`.
- `VIDEO_CLIP_MIN_SECONDS` / `VIDEO_CLIP_MAX_SECONDS` clamp each scene to the range
  the model accepts (4-12 for seedance). The clamped length is what the budget check
  and the cost record use, so the estimate matches what is billed.

Before enabling a new model, read its schema (`GET /v1/models/{owner}/{name}`,
`latest_version.openapi_schema`) and set these to match. The contract test in
`test/unit/replicate-seedance-contract.spec.ts` shows how to check a request
against a model's limits without spending anything.

### `VoiceProvider`

```ts
generateSpeech(request): Promise<ProviderResult<SpeechResult>>
listVoices(): Promise<VoiceDescriptor[]>
```

| Adapter | Notes |
| --- | --- |
| `mock` | Synthesises a tremolo-modulated tone of a realistic duration, so loudness normalisation behaves sensibly. |
| `elevenlabs` | Verified against the text-to-speech reference. Returns raw audio bytes, not JSON. |

Duration is measured with ffprobe after the fact rather than trusted from the
provider, because that is the number quality control needs to be right.

### `StorageProvider`

```ts
upload / uploadFromFile / download / downloadToFile
exists / stat / delete / getSignedUrl
```

| Adapter | Notes |
| --- | --- |
| `local` | Filesystem. Rejected in production by the config schema — it is not durable on Cloud Run. |
| `gcs` | Private objects, V4 signed URLs, resumable upload for files on disk. |

### `YouTubeProvider`

Deliberately narrow. It can authenticate a channel you own, publish to it, and
read that channel's own statistics. It has **no** capability to download anyone
else's content and none to interact with other accounts — the constraints are
enforced by the shape of the interface, not only by policy.

Uploads use the resumable protocol implemented directly, because the SDK wrapper
hides the session URI — which is exactly the value that must survive a restart for
a retry to continue instead of re-sending 100 MB.

### `QueueProvider`

| Adapter | Notes |
| --- | --- |
| `inmemory` | The durable queue is the `Job` table; a poller drains it. Nothing is lost on restart. |
| `cloudtasks` | Hands the job to Cloud Tasks, which calls back into `/internal/tasks/run` with an OIDC token. This is what lets Cloud Run scale to zero. |

---

## 4. Cost accounting

Every billable call goes through `MeteredExecutor`, which:

1. Checks the budget **before** the call (refusing after the money is spent would
   be pointless).
2. Makes the call.
3. Records a `CostRecord` with the provider's reported usage, or the pre-call
   estimate when the provider reports none.

There is no second path that spends money without being counted.

Pricing comes from configuration (`LLM_INPUT_COST_PER_MTOK`, `VIDEO_COST_PER_SECOND`,
`VOICE_COST_PER_1K_CHARS`), so a vendor price change is a configuration change.

---

## 5. Resilience

Adapters use `ProviderHttpClient`, which supplies timeout, bounded retries with
exponential backoff and full jitter, rate-limit awareness, and typed errors.

Retryability follows the SDK's typed error classes rather than string matching, so
a reworded upstream message cannot silently change behaviour. Non-retryable
failures (authentication, validation) fail immediately rather than burning the
retry budget three times for the same outcome.

---

## 6. Adding an adapter

1. Implement the port under `src/providers/<kind>/<name>-<kind>.provider.ts`.
   `BaseProvider` requires `isConfigured()`, `missingConfiguration()`,
   `healthCheck()` and `describe()` — these drive the Providers and Health pages.
2. Add the name to the relevant enum in `src/config/env.schema.ts`, with any
   required-key validation.
3. Register the class in `ProvidersModule` and add a branch to its factory.
4. Write an adapter test with the HTTP layer mocked. **Tests must never call a
   real paid API** — the test bootstrap fails any unmocked outbound request.

The domain needs no change. That is the point.
