# Security

What the platform protects, how, and what it deliberately does not do.

---

## 1. Threat model

| Threat | Mitigation |
| --- | --- |
| Repository or backup leak | No secrets in git. `.env` ignored; only `.env.example` is committed. |
| Database dump | Sessions stored hashed; OAuth refresh tokens encrypted; passwords scrypt-hashed. |
| Stolen session cookie | httpOnly + Secure + SameSite, `__Host-` prefix in production, absolute **and** idle expiry, server-side revocation. |
| Cross-site request forgery | Double-submit CSRF token required on every mutating request. |
| Compromised dependency reading logs | Redaction applied before anything is written. |
| Someone calling the worker endpoints | `/internal/*` requires OIDC (production) or a shared secret; a user session is never sufficient. |
| Command injection through generated content | ffmpeg receives argument arrays; no shell is ever spawned. |
| Path traversal through a storage key | Keys resolved against the storage root and re-checked afterwards. |
| Runaway spend | Budget checked before every paid call; exceeding it pauses generation. |
| Accidental publication | `DRY_RUN`, `REQUIRE_APPROVAL`, `AUTO_PUBLISH`, quotas, and the emergency stop. |

Explicitly **out of scope**: this is an internal operator console, not a
multi-tenant product. Anyone with an account is trusted to operate the channel;
roles limit accidents, not a determined insider.

---

## 2. Authentication

Server-side sessions rather than stateless JWTs, because revocation must be
immediate — a self-contained token would need a denylist, which is a session
table with extra steps.

- The session token is 256 bits from `randomBytes`, delivered **only** as a cookie.
- The database stores `sha256(token)`. A dump therefore yields nothing usable.
- Two independent expiries: an absolute TTL (`SESSION_TTL_HOURS`) and an idle
  timeout (`SESSION_IDLE_TIMEOUT_MINUTES`).
- Cookie flags: `httpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`.
- In production the cookie is named `__Host-shorts_session`. The browser then
  refuses it unless it is Secure, path `/`, and has no `Domain` — which pins it to
  the exact origin and blocks subdomain injection.

### Passwords

scrypt from Node's standard library: memory-hard, no native build step, no extra
supply-chain surface.

- Parameters `N=65536, r=8, p=1` (~64 MB per hash), stored inside the hash so they
  can be raised later without invalidating existing passwords.
- Per-password random salt.
- `needsRehash` transparently upgrades a hash on the next successful login.
- Verification refuses absurd parameters, so a crafted row cannot exhaust memory.
- Failed logins are padded to a minimum duration and always run a real hash
  computation, so an unknown email costs the same as a known one — otherwise
  response timing enumerates accounts.

### CSRF

Double-submit: a random secret is bound to the session, returned in the login
response body, and echoed by the client in `x-csrf-token`. The API compares them
in constant time. Safe methods are exempt; everything else is rejected without it.

The browser only ever talks to the dashboard's own origin (requests are proxied
server-side), so the cookie needs no cross-site relaxation.

---

## 3. Secrets

| Secret | Where it lives | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | env / Secret Manager | 32 bytes base64 |
| `ENCRYPTION_KEY` | env / Secret Manager | 32 bytes base64, AES-256-GCM |
| `INTERNAL_API_KEY` | env / Secret Manager | local `/internal/*` only |
| Provider API keys | env / Secret Manager | never sent to the browser |
| OAuth client secret | env / Secret Manager | never sent to the browser |
| OAuth refresh tokens | database, **encrypted** | decrypted only in memory, immediately before use |

Terraform creates the secret *containers*; values are added out of band, so they
never enter Terraform state:

```bash
printf '%s' "$(openssl rand -base64 32)" | \
  gcloud secrets versions add shorts-prod-encryption-key --data-file=-
```

### Token encryption

AES-256-GCM, format `v1:<iv>:<tag>:<ciphertext>`, all base64. The version prefix
means an algorithm change can be rolled out without a flag day. GCM is
authenticated, so tampering fails to decrypt rather than yielding garbage.

### <a id="key-rotation"></a>Key rotation

Rotating `ENCRYPTION_KEY` makes every stored refresh token undecryptable. There is
no automatic re-encryption, because doing it wrong silently locks you out of every
channel. The safe procedure:

1. Put the system in emergency stop.
2. Disconnect every channel in the dashboard (this revokes at Google too).
3. Change the key.
4. Reconnect each channel.
5. Lift the emergency stop.

`OAuthCredential.keyVersion` exists so a future migration can do this in place.

Rotating `SESSION_SECRET` simply signs everyone out.

---

## 4. Authorisation

Three roles: `ADMIN`, `EDITOR`, `VIEWER`.

- Every route requires a session **unless** explicitly marked `@Public()`. The
  guard is registered globally, so forgetting a decorator fails closed.
- Destructive and configuration actions require `ADMIN`; content actions allow
  `EDITOR`; everything else is readable by any signed-in user.
- `/internal/*` is marked `@Internal()` and is unreachable with a user session,
  in either direction.

In production, Cloud Run IAM means the API is not publicly invocable at all: only
the dashboard's service account and the invoker account may call it.

---

## 5. Input handling

- Every request body and query string is parsed by a zod schema from
  `@shorts/contracts`. An unparsed value never reaches a service.
- The same schemas validate LLM output. A response that does not satisfy the
  contract is a failure, not something to paper over with defaults.
- The environment is validated at boot; the process refuses to start on a bad value.

---

## 6. Logging

Two layers, both required:

1. **pino redaction paths** strip known-sensitive fields before serialisation.
2. **`redact()`** deep-walks anything persisted to `SystemLog`, masking values by
   key name *and* by shape — bearer tokens, `sk-` keys, Google OAuth tokens,
   `AIza…` keys, and credentials embedded in connection strings, even under an
   innocuous key.

Query strings are stripped from logged URLs, because OAuth callbacks carry codes
in them. Depth and length are bounded, and cycles are broken, so logging can never
be the thing that takes the process down.

---

## 7. Media handling

The only place that spawns a process is `FfmpegRunner`. A lint rule fails the
build if anything else imports `child_process`.

- Arguments are always arrays. No shell, so a prompt or title containing shell
  metacharacters is inert.
- Every invocation has a hard timeout and a bounded stderr buffer.
- Temporary directories are created with `mkdtemp` and removed in `finally`.

---

## 8. Storage

- Objects are private. `public_access_prevention` is enforced on the bucket.
- The dashboard receives short-lived V4 signed URLs, never permanent links.
- The local provider rejects absolute keys and re-checks the resolved path against
  the storage root, so `../` cannot escape.

---

## 9. Rate limiting

Global throttling via `@nestjs/throttler` (`RATE_LIMIT_*`), with a tighter budget
for authentication (`RATE_LIMIT_AUTH_MAX_REQUESTS`).

---

## 10. Content safety

Covered by the deterministic rule layer plus an optional model reviewer. Rules run
first and cannot be argued with by the text they are inspecting. Uncertainty
always resolves to human review, never to `ALLOW` — including when the model
reviewer is unavailable.

Child-safety rules are categorical: any sexualised description, any reference to a
real identifiable child, and any depiction of a child in danger are hard blocks
regardless of context.

---

## 11. Reporting a vulnerability

Do not open a public issue. Contact the repository owner directly with steps to
reproduce and the impact you believe it has.
