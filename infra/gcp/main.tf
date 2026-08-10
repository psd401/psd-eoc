locals {
  application_labels = {
    application                = "psd-eoc"
    environment                = "single"
    goog-terraform-provisioned = "true"
    managed-by                 = "terraform"
    purpose                    = "staff-identity"
  }

  cloud_identity_groups_readonly_scope = "https://www.googleapis.com/auth/cloud-identity.groups.readonly"

  terraform_admin_roles = toset([
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountKeyAdmin",
    "roles/oauthconfig.editor",
    "roles/owner",
    "roles/resourcemanager.projectIamAdmin",
    "roles/serviceusage.serviceUsageAdmin",
    "roles/storage.admin",
    "roles/viewer",
  ])
}

resource "google_project" "psd_eoc" {
  project_id      = var.project_id
  name            = var.project_name
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

resource "google_project_service" "required" {
  for_each = setsubtract(
    var.required_services,
    toset(["serviceusage.googleapis.com"]),
  )

  project                    = google_project.psd_eoc.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
  deletion_policy            = "PREVENT"

  depends_on = [google_project_service.service_usage]
}

resource "google_project_iam_member" "terraform_admin" {
  for_each = local.terraform_admin_roles

  project = google_project.psd_eoc.project_id
  role    = each.value
  member  = "user:${lower(var.terraform_admin_email)}"

  depends_on = [google_project_service.required]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_storage_bucket" "terraform_state" {
  project                     = google_project.psd_eoc.project_id
  name                        = var.terraform_state_bucket
  location                    = upper(var.region)
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

  depends_on = [google_project_service.required["storage.googleapis.com"]]
}

resource "google_service_account" "roster_reader" {
  project      = google_project.psd_eoc.project_id
  account_id   = "roster-sync-reader"
  display_name = "PSD EOC roster sync reader"
  description  = "Reads configured staff Google Groups for roster snapshots; never writes Groups or sends notifications."

  deletion_policy = "PREVENT"

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required["iam.googleapis.com"]]
}
