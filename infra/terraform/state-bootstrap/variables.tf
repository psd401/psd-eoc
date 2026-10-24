# Every variable here is tenant configuration and therefore has no default, as
# in infra/terraform/stateful. A missing tfvars file fails the plan.

variable "aws_account_id" {
  description = "The twelve-digit AWS account that owns this deployment."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be twelve digits."
  }
}

variable "aws_region" {
  description = "The AWS region of the state bucket and of the partner user pool (stateful's aws_region)."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region must be an AWS region identifier such as us-east-2."
  }
}

variable "ses_region" {
  description = "The region of the district's SES identity (stateful's ses_region). It may equal aws_region."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.ses_region))
    error_message = "ses_region must be an AWS region identifier such as us-east-1."
  }
}

variable "environment" {
  description = "Deployment environment name: the psd:environment tag and stateful's environment."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,31}$", var.environment))
    error_message = "environment must be a lower-case name of 2 to 32 characters."
  }
}

variable "owner" {
  description = "Address of the team accountable for this deployment: the psd:owner tag."
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[a-z0-9-]+(\\.[a-z0-9-]+)+$", var.owner))
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

variable "github_subject_prefix" {
  description = <<-EOT
    Start of the OIDC subject GitHub issues for this repository, in GitHub's
    immutable form with owner and repository ids
    (`gh api repos/<owner>/<repo>/actions/oidc/customization/sub`). A
    recycled repository or organization name cannot match it
    (psd-dev-standards 08 PR flow 4).
  EOT
  type        = string

  validation {
    condition     = can(regex("^repo:[^@/:]+@[0-9]+/[^@/:]+@[0-9]+$", var.github_subject_prefix))
    error_message = "github_subject_prefix must be the immutable form repo:<owner>@<id>/<repo>@<id>."
  }
}

variable "break_glass_role_arns" {
  description = <<-EOT
    IAM role ARNs, besides the CI apply role, that may write the stateful
    state: the administrators who repair a broken apply (psd-dev-standards 08
    State rules). Give each role's full ARN as `aws iam get-role` prints it;
    an SSO permission set's role ARN includes its aws-reserved path.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.break_glass_role_arns) > 0 && alltrue([for arn in var.break_glass_role_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+$", arn))])
    error_message = "break_glass_role_arns must name at least one IAM role ARN."
  }
}
