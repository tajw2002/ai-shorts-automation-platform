terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State must not live on a laptop: it holds resource ids and, for some
  # resources, generated values. Configure with `terraform init -backend-config=…`.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}
