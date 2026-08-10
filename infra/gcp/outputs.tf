output "project" {
  description = "Terraform-managed Google Cloud project identity."
  value = {
    id     = google_project.psd_eoc.project_id
    name   = google_project.psd_eoc.name
    number = google_project.psd_eoc.number
    parent = "organizations/${var.organization_id}"
  }
}

output "terraform_state_bucket" {
  description = "Private, versioned bucket used by the GCS Terraform backend."
  value       = google_storage_bucket.terraform_state.name
}

output "google_groups_reader" {
  description = "Non-secret contract for the read-only roster-sync service account and its Admin SDK-managed Workspace authorization."
  value = {
    application_writes_google_groups = false
    domain_wide_delegation           = false
    email                            = google_service_account.roster_reader.email
    service_account_unique_id        = google_service_account.roster_reader.unique_id
    oauth_scopes                     = [local.cloud_identity_groups_readonly_scope]
    project_id                       = google_project.psd_eoc.project_id
    project_number                   = google_project.psd_eoc.number
    project_iam_roles                = []
    workspace_admin_role             = "_GROUPS_READER_ROLE"
    workspace_grant_api_managed      = true
  }
}

output "google_oauth_contract" {
  description = "Non-secret exact contracts for the console-created Google Auth Platform clients."
  value = {
    audience          = "internal"
    authorized_domain = "psd401.net"
    scopes            = ["openid", "email", "profile"]
    web = {
      application_type   = "web"
      javascript_origins = [var.web_origin]
      name               = "PSD EOC Web"
      redirect_uris      = [var.web_oauth_redirect_uri]
    }
    ios = {
      application_type = "ios"
      bundle_id        = var.mobile_application_id
      name             = "PSD EOC iOS"
    }
    android = {
      application_type       = "android"
      name                   = "PSD EOC Android"
      package_name           = var.mobile_application_id
      release_sha1_required  = true
      release_sha1_available = false
    }
    terraform_or_public_api_available = false
  }
}

output "aws_secrets_contract" {
  description = "Non-secret target contract for credential handoff; values are never Terraform inputs or outputs."
  value = {
    account_id           = "338414773271"
    groups_secret_name   = "/psd-eoc/google-groups"
    oauth_secret_name    = "/psd-eoc/google-oauth"
    region               = "us-west-2"
    required_aws_profile = "psd401-prr-prod"
  }
}
