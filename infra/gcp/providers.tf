provider "google" {
  billing_project       = var.project_id
  deletion_policy       = "PREVENT"
  region                = var.region
  user_project_override = true
}
