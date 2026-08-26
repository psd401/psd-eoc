provider "google-beta" {
  alias                 = "project_factory"
  deletion_policy       = "PREVENT"
  user_project_override = false
}

provider "google-beta" {
  deletion_policy       = "PREVENT"
  project               = var.project_id
  user_project_override = true
}
