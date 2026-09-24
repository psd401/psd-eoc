terraform {
  required_version = ">= 1.5.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.40.0"
    }
  }
}

variable "billing_account" {
  description = "District Google Cloud billing account attached to the project. Supplied by the operator tooling from infra/cdk.local.json; never committed."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account))
    error_message = "Billing account must use the canonical 6-6-6 uppercase form."
  }
}

variable "project_id" {
  description = "Globally unique Google Cloud project ID dedicated to PSD EOC. Supplied by the operator tooling from infra/cdk.local.json."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Project ID must be a valid Google Cloud project ID."
  }
}

variable "organization_id" {
  description = "District Google Cloud organization ID. Supplied by the operator tooling from infra/cdk.local.json."
  type        = string

  validation {
    condition     = can(regex("^[1-9][0-9]{0,19}$", var.organization_id))
    error_message = "Organization ID must be a numeric Google Cloud organization ID."
  }
}

variable "terraform_state_bucket" {
  description = "Globally unique private bucket the main root uses for Terraform state. Supplied by the operator tooling from infra/cdk.local.json."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$", var.terraform_state_bucket))
    error_message = "State bucket must be a valid Cloud Storage bucket name without dots."
  }
}

variable "terraform_admin_email" {
  description = "District administrator who alone may read and write Terraform state. Supplied by the operator tooling from infra/cdk.local.json."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9._%+-]+@[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$", var.terraform_admin_email))
    error_message = "The Terraform administrator must be a lowercase email address."
  }
}

provider "google" {
  region          = "us-west1"
  deletion_policy = "PREVENT"
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
  project_id      = var.project_id
  name            = "PSD EOC"
  org_id          = var.organization_id
  billing_account = var.billing_account

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
  name                        = var.terraform_state_bucket
  location                    = "US-WEST1"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  requester_pays              = false
  default_event_based_hold    = false
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

  depends_on = [
    google_project_service.cloud_billing,
    google_project_service.cloud_resource_manager,
    google_project_service.storage,
  ]
}

data "google_iam_policy" "terraform_state" {
  binding {
    role    = "roles/storage.objectAdmin"
    members = ["user:${var.terraform_admin_email}"]
  }
}

resource "google_storage_bucket_iam_policy" "terraform_state" {
  bucket      = google_storage_bucket.terraform_state.name
  policy_data = data.google_iam_policy.terraform_state.policy_data

  lifecycle {
    prevent_destroy = true
  }
}
