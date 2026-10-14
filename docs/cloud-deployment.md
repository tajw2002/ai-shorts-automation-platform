# Cloud deployment

Deploying to Google Cloud with Terraform and Cloud Build.

---

## 1. Topology

```
                    ┌──────────────────┐
  Cloud Scheduler ──┤                  │
       (cron)       │   OIDC token     │
                    │   from invoker   │
  Cloud Tasks ──────┤   service acct   │
       (jobs)       └────────┬─────────┘
                             ▼
   browser ──→ Cloud Run (web) ──→ Cloud Run (api) ──→ Cloud SQL (private IP)
                                        ├──────────→ Cloud Storage (private)
                                        └──────────→ Secret Manager
```

Decisions worth knowing:

- **The API is not publicly invocable.** Cloud Run IAM allows only the dashboard's
  service account and the invoker account. That is what makes `/internal/*` safe.
- **The database has no public IP.** It is reached over a VPC connector.
- **API and worker are the same image**, distinguished by `APP_ROLE`. One artefact
  to build, scan and promote.
- **Cron lives in Cloud Scheduler, not in the process.** A scale-to-zero service
  has nothing to run a timer in, and several instances running the same timer
  would duplicate work. The in-process cron stands down automatically whenever
  `QUEUE_PROVIDER=cloudtasks`.

---

## 2. Prerequisites

```bash
gcloud --version      # Google Cloud SDK
terraform -version    # >= 1.6
docker --version
```

```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
```

A billing account must be linked to the project.

---

## 3. State bucket

Terraform state holds resource ids and generated values, so it does not belong on
a laptop.

```bash
gsutil mb -l europe-west1 gs://YOUR_PROJECT-tfstate
gsutil versioning set on gs://YOUR_PROJECT-tfstate
```

---

## 4. Artifact Registry

```bash
gcloud artifacts repositories create shorts \
  --repository-format=docker \
  --location=europe-west1 \
  --description="AI Shorts Automation Platform"

gcloud auth configure-docker europe-west1-docker.pkg.dev
```

---

## 5. First images

Terraform needs images to point at, so build once by hand before the first apply.

```bash
export REGION=europe-west1
export PROJECT=$(gcloud config get-value project)
export REPO=$REGION-docker.pkg.dev/$PROJECT/shorts

docker build -f apps/api/Dockerfile -t $REPO/api:v0.1.0 .
docker build -f apps/web/Dockerfile -t $REPO/web:v0.1.0 .
docker push $REPO/api:v0.1.0
docker push $REPO/web:v0.1.0
```

> On Apple Silicon, add `--platform linux/amd64` to both builds — Cloud Run is
> amd64. The Prisma schema already declares the matching `binaryTargets`, so the
> query engine for the target platform is bundled either way.

---

## 6. Apply

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit: project_id, region, api_image, web_image, timezone, alert_email.

terraform init -backend-config="bucket=YOUR_PROJECT-tfstate"
terraform plan      # read this before applying
terraform apply
```

Roughly 15 minutes, dominated by Cloud SQL.

What it creates: a VPC with private service access and a connector; Cloud SQL
Postgres 17 with backups and point-in-time recovery; a private bucket with
lifecycle rules; three service accounts with least-privilege roles; secret
containers; a Cloud Tasks queue; both Cloud Run services; four Cloud Scheduler
jobs; and an alert policy if `alert_email` is set.

---

## 7. Populate the secrets

Terraform creates the containers but not the values, so nothing sensitive enters
state.

```bash
ENV=prod

printf '%s' "$(openssl rand -base64 32)" | gcloud secrets versions add shorts-$ENV-session-secret   --data-file=-
printf '%s' "$(openssl rand -base64 32)" | gcloud secrets versions add shorts-$ENV-encryption-key   --data-file=-
printf '%s' "$(openssl rand -hex 24)"    | gcloud secrets versions add shorts-$ENV-internal-api-key --data-file=-

printf '%s' "$LLM_KEY"            | gcloud secrets versions add shorts-$ENV-llm-api-key            --data-file=-
printf '%s' "$VIDEO_KEY"          | gcloud secrets versions add shorts-$ENV-video-provider-api-key --data-file=-
printf '%s' "$VOICE_KEY"          | gcloud secrets versions add shorts-$ENV-voice-provider-api-key --data-file=-
printf '%s' "$YT_CLIENT_ID"       | gcloud secrets versions add shorts-$ENV-youtube-client-id      --data-file=-
printf '%s' "$YT_CLIENT_SECRET"   | gcloud secrets versions add shorts-$ENV-youtube-client-secret  --data-file=-
```

`printf` rather than `echo` — a trailing newline in a key is a genuinely annoying
bug to track down. `--data-file=-` keeps the value out of your shell history.

`database-url` is populated by Terraform, since it assembles it from values it
already owns.

---

## 8. Migrate

The database is private, so run migrations through the proxy:

```bash
gcloud sql instances describe shorts-prod-db --format='value(connectionName)'
cloud-sql-proxy --port 5433 PROJECT:REGION:shorts-prod-db &

DATABASE_URL="postgresql://shorts:PASSWORD@localhost:5433/shorts?schema=public" \
  npm run db:deploy --workspace @shorts/api
```

Retrieve the password with:

```bash
gcloud secrets versions access latest --secret=shorts-prod-database-url
```

After this, Cloud Build applies migrations automatically before each deploy.

---

## 9. Finish the setup

1. Redeploy so the services pick up the secrets:
   ```bash
   gcloud run services update shorts-prod-api --region europe-west1
   ```
2. Add `<api-url>/api/v1/youtube/oauth/callback` to the OAuth client's authorised
   redirect URIs — see [youtube-setup.md](youtube-setup.md).
3. Open the dashboard URL and sign in.
4. Check **Health**: everything should be OK.
5. Connect a channel under **Channels**.

Create the first admin by setting `BOOTSTRAP_ADMIN_PASSWORD` and restarting the
service, or by running the seed against the database.

---

## 10. Continuous deployment

```bash
gcloud builds submit --config infra/cloudbuild/cloudbuild.yaml \
  --substitutions _REGION=europe-west1,_ENVIRONMENT=prod
```

The pipeline lints, typechecks and tests first (cheap failures first); builds both
images in parallel; **applies migrations before deploying**; deploys API then
dashboard; and smoke-tests the new revision, failing the build if it never becomes
healthy.

To trigger on push:

```bash
gcloud builds triggers create github \
  --repo-name=YOUR_REPO --repo-owner=YOUR_ORG \
  --branch-pattern='^main$' \
  --build-config=infra/cloudbuild/cloudbuild.yaml
```

Grant the Cloud Build service account `run.admin`, `iam.serviceAccountUser`,
`secretmanager.secretAccessor` and `artifactregistry.writer`.

---

## 11. Rollback

```bash
# List revisions
gcloud run revisions list --service shorts-prod-api --region europe-west1

# Send all traffic to a known-good one
gcloud run services update-traffic shorts-prod-api \
  --region europe-west1 --to-revisions shorts-prod-api-00007-abc=100
```

Rolling back code is instant. **Rolling back a migration is not** — Prisma
migrations are forward-only. If a deploy fails after migrating, roll the code back
and write a new corrective migration rather than trying to undo one.

---

## 12. Costs

Rough monthly figures for a low-volume channel (europe-west1, few videos a day).
Cloud pricing changes; treat these as orders of magnitude.

| Component | Estimate |
| --- | --- |
| Cloud SQL `db-f1-micro` | $8-15 |
| Cloud Run (scale to zero) | $0-5 |
| VPC connector (always on) | ~$8 |
| Cloud Storage (~50 GB) | ~$1 |
| Cloud Tasks + Scheduler | negligible |
| **Infrastructure subtotal** | **~$20-30** |
| AI providers | **dominates everything above** |

The infrastructure is not what costs money — video generation is. That is what
`MAX_DAILY_COST` is for, and why the platform tracks cost per *published* video
separately: rejected videos still cost money.

The VPC connector runs continuously and is the one line item that does not scale
to zero. Removing it means giving the database a public IP, which is not a trade
worth making.

---

## 13. Operations

**Logs**

```bash
gcloud run services logs read shorts-prod-api --region europe-west1 --limit 100
```

Structured JSON in production, so Cloud Logging indexes the fields:

```
resource.type="cloud_run_revision"
jsonPayload.videoId="cm..."
```

**Halting everything** — dashboard → Settings → Emergency stop. It pauses
generation and uploads *and* cancels queued work.

**Scaling down to nothing**

```bash
gcloud run services update shorts-prod-api --region europe-west1 --max-instances 0
```

**Database backups** are automatic (daily, 14 retained, PITR for 7 days):

```bash
gcloud sql backups list --instance shorts-prod-db
```

---

## 14. Teardown

```bash
cd infra/terraform
terraform destroy
```

`db_deletion_protection` defaults to `true`, so the database survives. Set it to
`false` and re-apply first if you genuinely want it gone — and take a backup:

```bash
gcloud sql export sql shorts-prod-db gs://YOUR_BUCKET/final-backup.sql --database=shorts
```

The state bucket and Artifact Registry repository are not managed by Terraform and
must be removed by hand.
