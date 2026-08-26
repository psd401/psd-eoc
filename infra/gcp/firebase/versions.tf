terraform {
  required_version = ">= 1.7.5, < 2.0.0"

  # Firebase state must never share the Google Groups state bucket or prefix.
  # Operators replace this deliberately unusable bucket through -backend-config.
  backend "gcs" {
    bucket = "replace-with-dedicated-firebase-state-bucket"
    prefix = "terraform/gcp/firebase-isolated"
  }

  required_providers {
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "7.40.0"
    }
  }
}
