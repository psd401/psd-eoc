terraform {
  required_version = ">= 1.5.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.40.0"
    }
  }
}

provider "google" {
  region = "us-west1"
}

locals {
  application_labels = {
    application                = "psd-eoc"
    environment                = "single"
    goog-terraform-provisioned = "true"
    managed-by                 = "terraform"
    purpose                    = "staff-identity"
  }
}

resource "google_project" "psd_eoc" {
  project_id      = "psd401-eoc"
  name            = "PSD EOC"
  org_id          = "482073499306"
  billing_account = "01760A-35A65E-94FB90"

  auto_create_network = false
  deletion_policy     = "PREVENT"
  labels              = local.application_labels

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_project_service" "service_usage" {
  project                    = google_project.psd_eoc.project_id
  service                    = "serviceusage.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
  deletion_policy            = "PREVENT"
}

resource "google_project_service" "storage" {
  project                    = google_project.psd_eoc.project_id
  service                    = "storage.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
  deletion_policy            = "PREVENT"

  depends_on = [google_project_service.service_usage]
}

# The main provider bills API requests to the new project. Enable every API
# that provider initialization and google_project refresh require before the
# main root can enable project-charged quota without a first-run cycle.
resource "google_project_service" "cloud_resource_manager" {
  project                    = google_project.psd_eoc.project_id
  service                    = "cloudresourcemanager.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
  deletion_policy            = "PREVENT"

  depends_on = [google_project_service.service_usage]
}

resource "google_project_service" "cloud_billing" {
  project                    = google_project.psd_eoc.project_id
  service                    = "cloudbilling.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
  deletion_policy            = "PREVENT"

  depends_on = [google_project_service.service_usage]
}

resource "google_storage_bucket" "terraform_state" {
  project                     = google_project.psd_eoc.project_id
  name                        = "psd401-eoc-terraform-state"
  location                    = "US-WEST1"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  deletion_policy             = "PREVENT"
  labels                      = local.application_labels

  versioning {
    enabled = true
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }

    condition {
      days_since_noncurrent_time = 90
      send_age_if_zero           = false
      with_state                 = "ARCHIVED"
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.storage]
}

data "google_iam_policy" "terraform_state" {
  binding {
    role    = "roles/storage.objectAdmin"
    members = ["user:kjh_admin@psd401.net"]
  }
}

resource "google_storage_bucket_iam_policy" "terraform_state" {
  bucket      = google_storage_bucket.terraform_state.name
  policy_data = data.google_iam_policy.terraform_state.policy_data

  lifecycle {
    prevent_destroy = true
  }
}
