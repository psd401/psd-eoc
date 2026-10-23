# Every variable here is tenant configuration and therefore has no default. A
# missing tfvars file fails the plan instead of quietly provisioning somebody
# else's district.

variable "aws_account_id" {
  description = "The twelve-digit AWS account that owns this deployment."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be twelve digits."
  }
}

variable "aws_region" {
  description = "The AWS region that holds the partner user pool."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region must be an AWS region identifier such as us-east-2."
  }
}

variable "environment" {
  description = "Deployment environment name carried in the psd:environment tag."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,31}$", var.environment))
    error_message = "environment must be a lower-case name of 2 to 32 characters."
  }
}

variable "owner" {
  description = "Address of the team accountable for this deployment; the psd:owner tag."
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[a-z0-9][a-z0-9.-]+$", var.owner))
    error_message = "owner must be an email address."
  }
}

variable "source_repository_url" {
  description = "HTTPS URL of the repository that owns this configuration; the psd:repo tag."
  type        = string

  validation {
    condition     = can(regex("^https://[^[:space:]/]+/[^[:space:]]+$", var.source_repository_url))
    error_message = "source_repository_url must be an HTTPS repository URL."
  }
}

variable "passkey_relying_party_id" {
  description = <<-EOT
    The WebAuthn relying-party id for partner passkeys: the application's own
    hostname, such as eoc.example.invalid. A passkey is bound to this value, so
    changing it after partners have enrolled invalidates every passkey.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.passkey_relying_party_id))
    error_message = "passkey_relying_party_id must be a public hostname."
  }
}

variable "ses_identity_domain" {
  description = <<-EOT
    The verified SES domain identity, in this account and region, that partner
    invitations and one-time passwords are sent from. The same domain the
    stack's psdEoc:sesIdentityDomain names.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$", var.ses_identity_domain))
    error_message = "ses_identity_domain must be a domain name."
  }
}

variable "partner_email_from_address" {
  description = <<-EOT
    The From address on partner email, optionally with a display name, such as
    "EOC Alerts <eoc-alerts@example.invalid>". It must be an address in
    ses_identity_domain.
  EOT
  type        = string

  validation {
    condition     = can(regex("^([^<>]+ <)?[^@<>[:space:]]+@[a-z0-9][a-z0-9.-]+>?$", var.partner_email_from_address))
    error_message = "partner_email_from_address must be an email address, optionally as \"Name <address>\"."
  }

  validation {
    condition     = endswith(lower(trimsuffix(var.partner_email_from_address, ">")), "@${var.ses_identity_domain}")
    error_message = "partner_email_from_address must be an address in ses_identity_domain."
  }
}
