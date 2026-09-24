terraform {
  required_version = ">= 1.5.7"

  # The tenant's state bucket lives in the git-ignored infra/cdk.local.json.
  # scripts/apply.ts replaces this deliberately unusable bucket through
  # -backend-config on every init of this root.
  backend "gcs" {
    bucket = "replace-with-tenant-terraform-state-bucket"
    prefix = "terraform/gcp"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.40.0"
    }

  }
}
