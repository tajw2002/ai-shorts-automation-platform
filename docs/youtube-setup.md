# YouTube setup

Connecting a channel so the platform can publish to it.

**The platform never sees your Google password.** It receives an OAuth refresh
token, stores it encrypted, and you can revoke it at any time from your Google
account.

---

## 1. What is requested, and what is not

| Scope | Why |
| --- | --- |
| `youtube.upload` | Upload videos to your channel |
| `youtube.readonly` | Read your channel's own metadata and statistics |
| `yt-analytics.readonly` | Read view-duration data for your own videos |

Not requested, and not implementable with these scopes: commenting, subscribing,
rating, messaging, or touching any account other than the one you authorise.

---

## 2. Enable the API

```bash
gcloud services enable youtube.googleapis.com youtubeanalytics.googleapis.com
```

Or: **Google Cloud Console → APIs & Services → Library → YouTube Data API v3 → Enable.**

---

## 3. OAuth consent screen

Google now calls this the **Google Auth Platform** (it used to be "APIs & Services →
OAuth consent screen"). **Menu → Google Auth platform.** If the project has never
been configured, click **Get started** and fill in:

1. **App information**: app name, user support email.
2. **Audience**: *External*, unless the channel is owned by a Google Workspace
   organisation and only users inside it need access.
3. **Contact information**: developer email.
4. Accept the user data policy and **Create**.

Then:

- **Audience → Test users → Add users**: add the Google account that owns the
  channel. While the app is in Testing, nobody else can authorise it.
- **Data Access → Add or Remove Scopes**: add the three scopes from section 1. They
  only appear in the picker once both APIs from section 2 are enabled. They are
  *sensitive*, which matters for section 5.

> **While the app is in Testing**, only listed test users can authorise it, and
> refresh tokens expire after **7 days**. That is fine for evaluation and is why
> a channel may need reconnecting during the first week. Publishing the app (below)
> removes the expiry.

---

## 4. OAuth client

**Menu → Google Auth platform → Clients → Create Client.**

- **Application type**: *Web application*
- **Name**: anything, e.g. `AI Shorts Platform`
- **Authorized redirect URIs → Add URI** — add every environment you will use:

| Environment | URI |
| --- | --- |
| Local | `http://localhost:3001/api/v1/youtube/oauth/callback` |
| Production | `https://<your-api-url>/api/v1/youtube/oauth/callback` |

The redirect URI must match **exactly** — scheme, host, port, path. A trailing
slash is a different URI and Google will reject it.

> **Copy the client secret the moment it is shown.** For clients created since
> June 2025, Google displays the secret **only once**, at creation; afterwards the
> console shows just its last four characters and the original cannot be
> recovered. If it is lost, add a new secret with the client's rotation feature.
>
> Google's credential guide says web clients do not use a secret — that applies to
> purely browser-side apps. This platform exchanges the authorization code on the
> server, which requires the secret.

---

## 5. Publishing the app (optional but recommended)

For unattended operation you want tokens that do not expire after 7 days, which
means moving the app out of Testing.

Because the scopes are sensitive, Google requires verification: a privacy policy
URL, a homepage that explains what the app does, and usually a short video
demonstrating the OAuth flow. Review takes days to weeks.

Until then, Testing mode works — just expect to reconnect the channel weekly.

### Uploads from an unaudited project are always private

This is a separate restriction from the consent-screen verification above, and it
does not go away when the app is published. Google's documentation for
`videos.insert` states:

> All videos uploaded via the `videos.insert` endpoint from unverified API
> projects created after 28 July 2020 will be restricted to private viewing mode.

Setting `privacyStatus` to `public` does not change this, and the upload does not
fail: it succeeds, and the video is locked as private (reports describe an email
from YouTube saying so). Treat such a video as **not switchable to public** in
YouTube Studio.

Until the project passes the audit:

- Uploads from this platform are private, for review only. The dashboard still
  labels them *published*, meaning "uploaded".
- To make a video public, upload its MP4 by hand in YouTube Studio.
- `AUTO_PUBLISH` cannot make anything public.

Lifting the restriction requires the **YouTube API Services – Audit and Quota
Extension Form**, which reviews the project against the YouTube API Services Terms
of Service (see Google's
[quota and compliance audit guide](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)).

---

## 6. Configure the platform

Local, in `.env`:

```bash
YOUTUBE_PROVIDER=google
YOUTUBE_CLIENT_ID=<client id>
YOUTUBE_CLIENT_SECRET=<client secret>
YOUTUBE_REDIRECT_URI=http://localhost:3001/api/v1/youtube/oauth/callback
YOUTUBE_DEFAULT_CATEGORY_ID=24
YOUTUBE_MADE_FOR_KIDS=false
```

Production — into Secret Manager, never a file:

```bash
printf '%s' "<client id>"     | gcloud secrets versions add shorts-prod-youtube-client-id --data-file=-
printf '%s' "<client secret>" | gcloud secrets versions add shorts-prod-youtube-client-secret --data-file=-
```

### Category ids

| Id | Category |
| --- | --- |
| 1 | Film & Animation |
| 22 | People & Blogs |
| 23 | Comedy |
| 24 | Entertainment *(default)* |
| 27 | Education |

### "Made for kids"

`YOUTUBE_MADE_FOR_KIDS` sets YouTube's COPPA declaration on every upload.

**Decide this deliberately — it is a legal declaration, not a preference.**
[YouTube's guidance](https://support.google.com/youtube/answer/9528076) lists the
factors it weighs, among them: the intended audience, "animated characters or
cartoon figures", whether "the language of the video is intended for children to
understand", "simple songs or games", and "stories" for children. It also states
that it is the creator's "legal responsibility to comply with COPPA and/or other
applicable laws and designate your content accurately".

The content engine's default niche — cute animated baby and animal stories in simple
language — matches most of those factors. The two directions of error are not
symmetrical: declaring child-directed content as *not* made for kids is the
direction with legal exposure under COPPA; declaring content as made for kids when
it is not mainly costs features (comments, notifications, personalised ads). When in
doubt, `true` is the conservative choice.

---

## 7. Connect the channel

1. Sign in to the dashboard.
2. **Menu → Publishing** (the page is titled *Channels*) **→ Connect a channel**.
3. Authorise on the Google consent screen with the account that owns the channel.
4. You are returned to the dashboard, which confirms the connection.

Behind the scenes: a single-use `state` nonce is verified before the code is
exchanged, so a forged or replayed callback goes no further; the refresh token is
encrypted with AES-256-GCM before it touches the database; the access token is
cached and refreshed automatically a few minutes before it expires.

### If it fails

**"Google did not return a refresh token"**
Google only issues one on first authorisation. Revoke the app at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) and
connect again.

**`redirect_uri_mismatch`**
The URI in the OAuth client does not exactly match `YOUTUBE_REDIRECT_URI`.

**"The authorisation link is invalid or has expired"**
The `state` nonce is single-use and lives ten minutes. Start again from the
dashboard rather than re-using an old link.

**"The authorised account has no YouTube channel"**
The Google account you authorised with does not own a channel. Create one, or
authorise with the account that does.

---

## 8. Upload quotas

The YouTube Data API grants 10,000 quota units per day by default. An upload costs
**1,600**, so roughly **six uploads per day** before other calls are counted.

The platform's own `MAX_DAILY_UPLOADS` defaults to 3, comfortably inside that.
Raising it much beyond 5 means requesting a quota increase from Google.

Reads are cheap: a `videos.list` for statistics costs 1 unit for up to 50 ids,
which is why analytics batches.

---

## 9. Verifying without publishing anything

With `DRY_RUN=true` and `YOUTUBE_PROVIDER` set to anything, the mock adapter runs
the entire publish path — guards, quotas, upload job bookkeeping, progress
reporting, analytics polling — without a byte leaving the machine.

Use it to confirm the workflow before your first real upload:

```bash
DRY_RUN=true npm run dev
```

The dashboard labels every simulated upload as such, and the `UploadJob` row
records `simulated = true`.
