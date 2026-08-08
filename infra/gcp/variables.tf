variable "project_id" {
  description = "Globally unique Google Cloud project ID dedicated to PSD EOC."
  type        = string
  default     = "psd401-eoc"

  validation {
    condition     = var.project_id == "psd401-eoc"
    error_message = "This root is intentionally bound to the psd401-eoc project."
  }
}

variable "project_name" {
  description = "Human-readable Google Cloud project name."
  type        = string
  default     = "PSD EOC"

  validation {
    condition     = var.project_name == "PSD EOC"
    error_message = "This root is intentionally bound to the PSD EOC project name."
  }
}

variable "organization_id" {
  description = "Peninsula School District Google Cloud organization ID."
  type        = string
  default     = "482073499306"

  validation {
    condition     = var.organization_id == "482073499306"
    error_message = "This root is intentionally bound to the district organization."
  }
}

variable "billing_account" {
  description = "District Google Cloud billing account attached to the project."
  type        = string
  default     = "<billing-account>"

  validation {
    condition     = var.billing_account == "<billing-account>"
    error_message = "This root is intentionally bound to the district billing account."
  }
}

variable "region" {
  description = "Default region for Google Cloud resources."
  type        = string
  default     = "us-west1"

  validation {
    condition     = var.region == "us-west1"
    error_message = "PSD EOC Google resources use us-west1."
  }
}

variable "terraform_state_bucket" {
  description = "Globally unique private bucket used only for PSD EOC Terraform state."
  type        = string
  default     = "psd401-eoc-terraform-state"

  validation {
    condition     = var.terraform_state_bucket == "psd401-eoc-terraform-state"
    error_message = "The checked-in backend and state bucket must remain identical."
  }
}

variable "terraform_admin_email" {
  description = "District administrator responsible for this Terraform root."
  type        = string
  default     = "kjh_admin@psd401.net"

  validation {
    condition     = lower(var.terraform_admin_email) == "kjh_admin@psd401.net"
    error_message = "This root is intentionally bound to the district Terraform administrator."
  }
}

variable "required_services" {
  description = "Google Cloud APIs required for project administration and read-only Workspace group access."
  type        = set(string)
  default = [
    "admin.googleapis.com",
    "cloudidentity.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
  ]

  validation {
    condition = var.required_services == toset([
      "admin.googleapis.com",
      "cloudidentity.googleapis.com",
      "cloudresourcemanager.googleapis.com",
      "iam.googleapis.com",
      "serviceusage.googleapis.com",
      "storage.googleapis.com",
    ])
    error_message = "The fixed, reviewed API allow-list cannot be expanded or reduced with TF_VAR overrides."
  }
}

variable "web_origin" {
  description = "Exact production JavaScript origin for the Google Auth Platform web client."
  type        = string
  default     = "https://eoc.psd401.net"

  validation {
    condition     = var.web_origin == "https://eoc.psd401.net"
    error_message = "PSD EOC uses one fixed production web origin."
  }
}

variable "web_oauth_redirect_uri" {
  description = "Exact production callback for the Google Auth Platform web client."
  type        = string
  default     = "https://eoc.psd401.net/auth/callback"

  validation {
    condition     = var.web_oauth_redirect_uri == "https://eoc.psd401.net/auth/callback"
    error_message = "PSD EOC uses one fixed production OAuth callback."
  }
}

variable "mobile_application_id" {
  description = "Canonical iOS bundle ID and Android package name for PSD EOC."
  type        = string
  default     = "net.psd401.eoc"

  validation {
    condition     = var.mobile_application_id == "net.psd401.eoc"
    error_message = "PSD EOC mobile clients use net.psd401.eoc."
  }
}
