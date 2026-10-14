# =============================================================================
# AI Shorts Automation Platform — Google Cloud infrastructure
# =============================================================================
# Topology (see docs/cloud-deployment.md):
#
#   Cloud Scheduler ─┐
#                    ├─ OIDC ─→ Cloud Run (api)  ─→ Cloud SQL (private IP)
#   Cloud Tasks    ──┘                           ─→ Cloud Storage
#                                                └─→ Secret Manager
#   Cloud Run (web) ─ session cookie ─→ Cloud Run (api)
#
# Principles applied throughout:
#   * Least privilege — each workload has its own service account with only the
#     roles it needs. Nothing runs as the default compute account.
#   * No public database — Cloud SQL has private IP only, reached over the VPC
#     connector.
#   * No secrets in Terraform state — secret *containers* are created here and
#     their values are added out of band with `gcloud secrets versions add`.
# =============================================================================

locals {
  suffix = var.environment
  name   = "shorts-${local.suffix}"

  required_apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudscheduler.googleapis.com",
    "artifactregistry.googleapis.com",
    "storage.googleapis.com",
    "vpcaccess.googleapis.com",
    "servicenetworking.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
  ]

  # Values that are not secret and are safe to hold in the service definition.
  common_env = {
    NODE_ENV             = "production"
    TIMEZONE             = var.timezone
    DRY_RUN              = tostring(var.dry_run)
    REQUIRE_APPROVAL     = tostring(var.require_approval)
    AUTO_PUBLISH         = tostring(var.auto_publish)
    MAX_DAILY_UPLOADS    = tostring(var.max_daily_uploads)
    MAX_DAILY_COST       = tostring(var.max_daily_cost_usd)
    MAX_MONTHLY_COST     = tostring(var.max_monthly_cost_usd)
    STORAGE_PROVIDER     = "gcs"
    QUEUE_PROVIDER       = "cloudtasks"
    GCS_BUCKET           = google_storage_bucket.media.name
    GCP_PROJECT_ID       = var.project_id
    GCP_REGION           = var.region
    CLOUD_TASKS_QUEUE    = google_cloud_tasks_queue.jobs.name
    CLOUD_TASKS_LOCATION = var.region
  }
}

resource "google_project_service" "enabled" {
  for_each = toset(local.required_apis)

  project = var.project_id
  service = each.value

  # Disabling an API on destroy would break anything else in the project using it.
  disable_on_destroy = false
}

# -----------------------------------------------------------------------------
# Networking — private database access
# -----------------------------------------------------------------------------

resource "google_compute_network" "vpc" {
  name                    = "${local.name}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.enabled]
}

resource "google_compute_global_address" "private_ip" {
  name          = "${local.name}-private-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private_vpc" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip.name]
}

# Cloud Run is serverless and has no VPC of its own; the connector is what lets
# it reach a database that has no public address.
resource "google_vpc_access_connector" "connector" {
  name          = "${local.name}-conn"
  region        = var.region
  network       = google_compute_network.vpc.name
  ip_cidr_range = "10.8.0.0/28"
  min_instances = 2
  max_instances = 3

  depends_on = [google_project_service.enabled]
}

# -----------------------------------------------------------------------------
# Database
# -----------------------------------------------------------------------------

resource "google_sql_database_instance" "postgres" {
  name             = "${local.name}-db"
  region           = var.region
  database_version = "POSTGRES_17"

  deletion_protection = var.db_deletion_protection

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = 10
    disk_autoresize   = true

    ip_configuration {
      # No public IP: the only route in is the VPC connector.
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.vpc.id
      enable_private_path_for_google_cloud_services = true
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 14
      }
    }

    maintenance_window {
      day  = 7 # Sunday
      hour = 4
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  depends_on = [google_service_networking_connection.private_vpc]
}

resource "google_sql_database" "shorts" {
  name     = "shorts"
  instance = google_sql_database_instance.postgres.name
}

# Generated here so no human ever chooses or sees it; it goes straight into
# Secret Manager and is injected into Cloud Run from there.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  name     = "shorts"
  instance = google_sql_database_instance.postgres.name
  password = random_password.db.result
}

# -----------------------------------------------------------------------------
# Object storage
# -----------------------------------------------------------------------------

resource "google_storage_bucket" "media" {
  name     = "${var.project_id}-${local.name}-media"
  location = var.region

  # Objects are served through short-lived signed URLs, never publicly.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      age = 90
    }
    action {
      type = "Delete"
    }
  }

  # Scene clips are intermediates; the final render is what matters long term.
  lifecycle_rule {
    condition {
      age                = 30
      matches_prefix     = ["videos/"]
      num_newer_versions = 2
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.enabled]
}

# -----------------------------------------------------------------------------
# Service accounts — one per workload, least privilege
# -----------------------------------------------------------------------------

resource "google_service_account" "api" {
  account_id   = "${local.name}-api"
  display_name = "AI Shorts API"
}

resource "google_service_account" "web" {
  account_id   = "${local.name}-web"
  display_name = "AI Shorts dashboard"
}

# Used by Cloud Tasks and Cloud Scheduler to mint OIDC tokens for /internal/*.
resource "google_service_account" "invoker" {
  account_id   = "${local.name}-invoker"
  display_name = "AI Shorts internal invoker"
}

resource "google_project_iam_member" "api_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_tasks" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# The API creates tasks that run as the invoker account, which requires
# permission to act as it.
resource "google_service_account_iam_member" "api_acts_as_invoker" {
  service_account_id = google_service_account.invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.api.email}"
}

# Bucket-scoped rather than project-wide: the API may touch its own media and
# nothing else in the project.
resource "google_storage_bucket_iam_member" "api_bucket" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

# Signing a V4 URL requires the account to sign as itself.
resource "google_service_account_iam_member" "api_token_creator" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.api.email}"
}

# -----------------------------------------------------------------------------
# Secrets
#
# Only the containers are declared. Values are added out of band so they never
# enter Terraform state:
#
#   printf '%s' "$VALUE" | gcloud secrets versions add NAME --data-file=-
# -----------------------------------------------------------------------------

locals {
  managed_secrets = [
    "session-secret",
    "encryption-key",
    "internal-api-key",
    "llm-api-key",
    "video-provider-api-key",
    "voice-provider-api-key",
    "youtube-client-id",
    "youtube-client-secret",
  ]
}

resource "google_secret_manager_secret" "app" {
  for_each = toset(local.managed_secrets)

  secret_id = "${local.name}-${each.value}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

# The database URL is assembled from values Terraform already owns, so it is the
# one secret whose value is managed here.
resource "google_secret_manager_secret" "database_url" {
  secret_id = "${local.name}-database-url"

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.database_url.id
  secret_data = format(
    "postgresql://%s:%s@%s:5432/%s?schema=public",
    google_sql_user.app.name,
    random_password.db.result,
    google_sql_database_instance.postgres.private_ip_address,
    google_sql_database.shorts.name,
  )
}

resource "google_secret_manager_secret_iam_member" "api_access" {
  for_each = merge(
    { for name in local.managed_secrets : name => google_secret_manager_secret.app[name].secret_id },
    { "database-url" = google_secret_manager_secret.database_url.secret_id },
  )

  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

# -----------------------------------------------------------------------------
# Queue
# -----------------------------------------------------------------------------

resource "google_cloud_tasks_queue" "jobs" {
  name     = "${local.name}-jobs"
  location = var.region

  rate_limits {
    # Bounded on purpose: generation is expensive, and a burst would spend the
    # daily budget in minutes.
    max_dispatches_per_second = 5
    max_concurrent_dispatches = 10
  }

  retry_config {
    # The application owns retry policy via the Job table; Cloud Tasks retries
    # only to cover delivery failures, not application errors.
    max_attempts       = 3
    min_backoff        = "10s"
    max_backoff        = "300s"
    max_retry_duration = "3600s"
  }

  depends_on = [google_project_service.enabled]
}
