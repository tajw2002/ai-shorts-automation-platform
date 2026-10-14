variable "project_id" {
  description = "Google Cloud project id."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL, Cloud Tasks and the bucket."
  type        = string
  default     = "europe-west1"
}

variable "environment" {
  description = "Environment name, used as a resource-name suffix."
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,12}$", var.environment))
    error_message = "environment must be lowercase alphanumeric with hyphens, 2-13 characters."
  }
}

variable "api_image" {
  description = "Fully qualified API image, e.g. europe-west1-docker.pkg.dev/PROJECT/shorts/api:TAG."
  type        = string
}

variable "web_image" {
  description = "Fully qualified dashboard image."
  type        = string
}

variable "timezone" {
  description = "IANA timezone driving schedules and quota windows."
  type        = string
  default     = "Europe/Berlin"
}

# ---------------------------------------------------------------------------
# Safety switches.
#
# These default to the conservative setting on purpose: a freshly applied
# environment must not be able to publish anything until an operator decides so.
# ---------------------------------------------------------------------------

variable "dry_run" {
  description = "When true, mock providers are used and nothing is uploaded."
  type        = bool
  default     = true
}

variable "require_approval" {
  description = "Require a human to approve every video before it may be uploaded."
  type        = bool
  default     = true
}

variable "auto_publish" {
  description = "Allow the scheduler to publish without a human. Keep false until proven."
  type        = bool
  default     = false
}

variable "max_daily_uploads" {
  description = "Hard cap on uploads per day."
  type        = number
  default     = 3
}

variable "max_daily_cost_usd" {
  description = "Hard cap on provider spend per day, in USD."
  type        = number
  default     = 10
}

variable "max_monthly_cost_usd" {
  description = "Hard cap on provider spend per month, in USD."
  type        = number
  default     = 200
}

variable "db_tier" {
  description = "Cloud SQL machine type."
  type        = string
  default     = "db-f1-micro"
}

variable "db_deletion_protection" {
  description = "Prevents `terraform destroy` from dropping the database."
  type        = bool
  default     = true
}

variable "api_min_instances" {
  description = "Minimum API instances. 0 scales to zero; 1 removes cold starts."
  type        = number
  default     = 0
}

variable "api_max_instances" {
  description = "Upper bound on API instances, which also bounds cost."
  type        = number
  default     = 4
}

variable "schedule_cron_generation" {
  description = "Cron for the scheduler tick (in var.timezone)."
  type        = string
  default     = "*/15 * * * *"
}

variable "schedule_cron_analytics" {
  description = "Cron for the analytics sync."
  type        = string
  default     = "0 */3 * * *"
}

variable "alert_email" {
  description = "Address for budget and error alerts. Empty disables alerting."
  type        = string
  default     = ""
}
