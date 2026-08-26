locals {
  labels = {
    application                = "eoc"
    boundary                   = "firebase-isolated"
    goog-terraform-provisioned = "true"
    managed-by                 = "terraform"
    purpose                    = "push-handoff"
  }
}

resource "google_project" "firebase" {
  provider = google-beta.project_factory

  project_id      = var.project_id
  name            = var.project_name
  org_id          = var.organization_id
  billing_account = var.billing_account

  auto_create_network = false
  deletion_policy     = "PREVENT"
  labels              = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_project_service" "service_usage" {
  provider = google-beta.project_factory

  project                    = google_project.firebase.project_id
  service                    = "serviceusage.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
  deletion_policy            = "PREVENT"
}

resource "google_project_service" "required" {
  provider = google-beta.project_factory
  for_each = setsubtract(
    var.required_services,
    toset(["serviceusage.googleapis.com"]),
  )

  project                    = google_project.firebase.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
  deletion_policy            = "PREVENT"

  depends_on = [google_project_service.service_usage]
}

resource "google_firebase_project" "push" {
  provider = google-beta
  project  = google_project.firebase.project_id

  depends_on = [google_project_service.required]
}

resource "google_firebase_android_app" "push" {
  provider = google-beta

  project         = google_firebase_project.push.project
  display_name    = var.android_display_name
  package_name    = var.android_package_name
  deletion_policy = "PREVENT"

  depends_on = [google_firebase_project.push]

  lifecycle {
    prevent_destroy = true
  }
}
