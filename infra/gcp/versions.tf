terraform {
  required_version = ">= 1.5.7"

  backend "gcs" {
    bucket = "psd401-eoc-terraform-state"
    prefix = "terraform/gcp"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.40.0"
    }

  }
}
