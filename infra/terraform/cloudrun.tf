# =============================================================================
# Cloud Run services and the cron that drives them
# =============================================================================

locals {
  # Secrets injected as environment variables. Cloud Run fetches the value at
  # instance start, so a rotated secret takes effect on the next revision or
  # restart — never a redeploy of the image.
  api_secret_env = {
    DATABASE_URL           = google_secret_manager_secret.database_url.secret_id
    SESSION_SECRET         = google_secret_manager_secret.app["session-secret"].secret_id
    ENCRYPTION_KEY         = google_secret_manager_secret.app["encryption-key"].secret_id
    INTERNAL_API_KEY       = google_secret_manager_secret.app["internal-api-key"].secret_id
    LLM_API_KEY            = google_secret_manager_secret.app["llm-api-key"].secret_id
    VIDEO_PROVIDER_API_KEY = google_secret_manager_secret.app["video-provider-api-key"].secret_id
    VOICE_PROVIDER_API_KEY = google_secret_manager_secret.app["voice-provider-api-key"].secret_id
    YOUTUBE_CLIENT_ID      = google_secret_manager_secret.app["youtube-client-id"].secret_id
    YOUTUBE_CLIENT_SECRET  = google_secret_manager_secret.app["youtube-client-secret"].secret_id
  }
}

resource "google_cloud_run_v2_service" "api" {
  name     = "${local.name}-api"
  location = var.region

  # Traffic reaches the API through the dashboard and through OIDC-authenticated
  # infrastructure; it is not a public website.
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.api.email

    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.api_image

      resources {
        limits = {
          # ffmpeg is the memory-hungry step; 2Gi comfortably handles a 1080x1920
          # render, and the CPU is what makes encoding finish in seconds.
          cpu    = "2"
          memory = "2Gi"
        }
        # Encoding is CPU-bound and must keep running between requests.
        cpu_idle          = false
        startup_cpu_boost = true
      }

      ports {
        container_port = 8080
      }

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name  = "APP_ROLE"
        value = "all"
      }

      env {
        name  = "API_BASE_URL"
        value = "https://${local.name}-api-${data.google_project.current.number}.${var.region}.run.app"
      }

      env {
        name  = "WEB_BASE_URL"
        value = "https://${local.name}-web-${data.google_project.current.number}.${var.region}.run.app"
      }

      env {
        name  = "CORS_ALLOWED_ORIGINS"
        value = "https://${local.name}-web-${data.google_project.current.number}.${var.region}.run.app"
      }

      env {
        name  = "CLOUD_TASKS_INVOKER_SA"
        value = google_service_account.invoker.email
      }

      dynamic "env" {
        for_each = local.api_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        http_get {
          path = "/liveness"
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 12
        timeout_seconds       = 3
      }

      liveness_probe {
        http_get {
          path = "/liveness"
        }
        period_seconds    = 30
        failure_threshold = 3
        timeout_seconds   = 3
      }
    }

    # A render plus an upload can legitimately take several minutes.
    timeout = "900s"

    max_instance_request_concurrency = 20
  }

  depends_on = [
    google_project_service.enabled,
    google_secret_manager_secret_iam_member.api_access,
  ]
}

resource "google_cloud_run_v2_service" "web" {
  name     = "${local.name}-web"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.web.email

    scaling {
      min_instance_count = 0
      max_instance_count = 4
    }

    containers {
      image = var.web_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      ports {
        container_port = 8080
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      # Server-side rendering calls the API directly; the browser never does.
      env {
        name  = "API_INTERNAL_URL"
        value = google_cloud_run_v2_service.api.uri
      }
    }

    timeout = "60s"
  }

  depends_on = [google_project_service.enabled]
}

data "google_project" "current" {
  project_id = var.project_id
}

# -----------------------------------------------------------------------------
# Access control
# -----------------------------------------------------------------------------

# The dashboard is the operator's entry point and authenticates users itself.
resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# The API is *not* public at the platform level: only the dashboard and the
# invoker account may call it. That is what makes /internal/* safe.
resource "google_cloud_run_v2_service_iam_member" "api_from_web" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.web.email}"
}

resource "google_cloud_run_v2_service_iam_member" "api_from_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.invoker.email}"
}

# -----------------------------------------------------------------------------
# Cloud Scheduler
#
# Cloud Run scales to zero, so there is no process to hold a timer. Scheduler
# calls the internal endpoints, which is also why the in-process cron stands
# down whenever QUEUE_PROVIDER is cloudtasks.
# -----------------------------------------------------------------------------

locals {
  cron_jobs = {
    scheduler = {
      path        = "/internal/cron/scheduler"
      schedule    = var.schedule_cron_generation
      description = "Evaluates publishing schedules and keeps the pipeline stocked."
    }
    analytics = {
      path        = "/internal/cron/analytics"
      schedule    = var.schedule_cron_analytics
      description = "Refreshes YouTube statistics for published videos."
    }
    performance = {
      path        = "/internal/cron/performance-analysis"
      schedule    = "0 4 * * 1"
      description = "Re-derives performance insights from published videos."
    }
    maintenance = {
      path        = "/internal/cron/maintenance"
      schedule    = "0 3 * * *"
      description = "Requeues stale jobs and prunes expired sessions, logs and snapshots."
    }
  }
}

resource "google_cloud_scheduler_job" "cron" {
  for_each = local.cron_jobs

  name        = "${local.name}-${each.key}"
  region      = var.region
  description = each.value.description
  schedule    = each.value.schedule
  time_zone   = var.timezone

  attempt_deadline = "320s"

  retry_config {
    retry_count = 2
  }

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.api.uri}${each.value.path}"

    oidc_token {
      service_account_email = google_service_account.invoker.email
      audience              = google_cloud_run_v2_service.api.uri
    }
  }

  depends_on = [google_project_service.enabled]
}

# -----------------------------------------------------------------------------
# Alerting
# -----------------------------------------------------------------------------

resource "google_monitoring_notification_channel" "email" {
  count = var.alert_email == "" ? 0 : 1

  display_name = "${local.name} alerts"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }

  depends_on = [google_project_service.enabled]
}

resource "google_monitoring_alert_policy" "api_errors" {
  count = var.alert_email == "" ? 0 : 1

  display_name = "${local.name} API 5xx rate"
  combiner     = "OR"

  conditions {
    display_name = "5xx responses from the API"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "resource.labels.service_name = \"${google_cloud_run_v2_service.api.name}\"",
        "metric.type = \"run.googleapis.com/request_count\"",
        "metric.labels.response_code_class = \"5xx\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]

  documentation {
    content = "The API is returning server errors. Check the Logs page in the dashboard and Cloud Logging."
  }
}
