output "api_url" {
  description = "API base URL. Set YOUTUBE_REDIRECT_URI to this plus /api/v1/youtube/oauth/callback."
  value       = google_cloud_run_v2_service.api.uri
}

output "web_url" {
  description = "Dashboard URL — the operator's entry point."
  value       = google_cloud_run_v2_service.web.uri
}

output "database_instance" {
  description = "Cloud SQL instance connection name."
  value       = google_sql_database_instance.postgres.connection_name
}

output "media_bucket" {
  description = "Bucket holding renders, scenes and voice tracks."
  value       = google_storage_bucket.media.name
}

output "api_service_account" {
  description = "Service account the API runs as."
  value       = google_service_account.api.email
}

output "invoker_service_account" {
  description = "Account Cloud Tasks and Cloud Scheduler use to call /internal/*."
  value       = google_service_account.invoker.email
}

output "secrets_to_populate" {
  description = "Secrets whose values must be supplied out of band before the first deploy."
  value       = [for name in local.managed_secrets : google_secret_manager_secret.app[name].secret_id]
}

output "next_steps" {
  description = "What to do after `terraform apply`."
  value       = <<-EOT
    1. Populate each secret listed in `secrets_to_populate`:
         printf '%s' "$VALUE" | gcloud secrets versions add SECRET_ID --data-file=-
       Generate the two keys with: openssl rand -base64 32
    2. Run the database migration once, from a machine with database access:
         DATABASE_URL=... npm run db:deploy --workspace @shorts/api
    3. Add ${google_cloud_run_v2_service.api.uri}/api/v1/youtube/oauth/callback
       as an authorised redirect URI in the Google Cloud OAuth client.
    4. Open ${google_cloud_run_v2_service.web.uri} and connect a channel.
    5. Leave DRY_RUN=true until a full pipeline run has succeeded.
  EOT
}
