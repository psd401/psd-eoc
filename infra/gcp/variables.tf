variable "project_id" {
  description = "Globally unique Google Cloud project ID dedicated to PSD EOC. Supplied by the operator tooling from infra/cdk.local.json."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Project ID must be a valid Google Cloud project ID."
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
  description = "District Google Cloud organization ID. Supplied by the operator tooling from infra/cdk.local.json."
  type        = string

  validation {
    condition     = can(regex("^[1-9][0-9]{0,19}$", var.organization_id))
    error_message = "Organization ID must be a numeric Google Cloud organization ID."
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
  description = "Globally unique private bucket used only for PSD EOC Terraform state. Supplied by the operator tooling from infra/cdk.local.json, which also passes it as the backend bucket."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$", var.terraform_state_bucket))
    error_message = "State bucket must be a valid Cloud Storage bucket name without dots."
  }
}

variable "terraform_admin_email" {
  description = "District administrator responsible for this Terraform root. Supplied by the operator tooling from infra/cdk.local.json."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9._%+-]+@[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$", var.terraform_admin_email))
    error_message = "The Terraform administrator must be a lowercase email address."
  }
}

variable "authorized_domain" {
  description = "Google Workspace domain of every staff account, reported as the OAuth consent screen's authorized domain. Supplied by the operator tooling from infra/cdk.local.json."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$", var.authorized_domain))
    error_message = "Authorized domain must be a lowercase DNS domain."
  }
}

variable "aws_operator_profile" {
  description = "Named AWS CLI profile the credential handoff requires. Supplied by the operator tooling from infra/cdk.local.json."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", var.aws_operator_profile))
    error_message = "AWS operator profile must be a valid profile name."
  }
}

variable "required_services" {
  description = "Google Cloud APIs required for project administration and read-only Workspace group access."
  type        = set(string)
  default = [
    "admin.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudidentity.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
  ]

  validation {
    condition = var.required_services == toset([
      "admin.googleapis.com",
      "cloudbilling.googleapis.com",
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
  description = "Exact production JavaScript origin for the Google Auth Platform web client. Supplied by the operator tooling from infra/cdk.local.json."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$", var.web_origin))
    error_message = "PSD EOC uses one HTTPS production web origin with no path."
  }
}

variable "web_oauth_redirect_uri" {
  description = "Exact production callback for the Google Auth Platform web client. Supplied by the operator tooling as the web origin plus /auth/callback."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+/auth/callback$", var.web_oauth_redirect_uri))
    error_message = "PSD EOC uses one fixed production OAuth callback at /auth/callback on the web origin."
  }
}

variable "mobile_application_id" {
  description = "Canonical iOS bundle ID and Android package name for PSD EOC. Supplied by the operator tooling from infra/cdk.local.json."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$", var.mobile_application_id))
    error_message = "PSD EOC mobile clients share one reverse-DNS application ID."
  }
}

variable "aws_account_id" {
  description = "AWS account that receives the handed-off credentials. Set it in terraform.tfvars, which git ignores; it is reported, never used to create resources."
  type        = string
  default     = ""
}
