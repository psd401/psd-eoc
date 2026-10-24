# The permissions boundary on both CI roles (psd-dev-standards 08 guardrail 3):
# a ceiling, not a grant. Each role's own policies decide what it may do,
# within what this allows.

locals {
  boundary_name = "psd-eoc-${var.environment}-terraform-boundary"
  boundary_arn  = "arn:aws:iam::${var.aws_account_id}:policy/${local.boundary_name}"

  guarded_role_arns = [
    "arn:aws:iam::${var.aws_account_id}:role/${local.plan_role_name}",
    local.apply_role_arn,
  ]
  guarded_policy_arns = [
    local.boundary_arn,
    "arn:aws:iam::${var.aws_account_id}:policy/psd-eoc-${var.environment}-terraform-*",
  ]
}

data "aws_iam_policy_document" "boundary" {
  statement {
    sid       = "AllowWithinTheDenials"
    actions   = ["*"]
    resources = ["*"]
  }

  # No IAM users, so no long-lived keys (08 Baseline security).
  statement {
    sid       = "NoIamUsersOrKeys"
    effect    = "Deny"
    actions   = ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile"]
    resources = ["*"]
  }

  statement {
    sid       = "AuditStaysOn"
    effect    = "Deny"
    actions   = ["cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail", "config:Delete*", "config:Stop*"]
    resources = ["*"]
  }

  statement {
    sid       = "NoOrganizationOrAccountChanges"
    effect    = "Deny"
    actions   = ["organizations:*", "account:*"]
    resources = ["*"]
  }

  # CI creates no role of its own. Cognito's email service-linked role is
  # the one exception, made by iam:CreateServiceLinkedRole, which this does
  # not deny.
  statement {
    sid       = "NoNewRolesOrGrants"
    effect    = "Deny"
    actions   = ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:CreatePolicy", "iam:CreatePolicyVersion"]
    resources = ["*"]
  }

  # CI cannot widen its own access; only this root, applied by a person,
  # changes it.
  statement {
    sid       = "CiRolesAreFixed"
    effect    = "Deny"
    actions   = ["iam:Update*", "iam:Put*", "iam:Attach*", "iam:Detach*", "iam:Delete*", "iam:Tag*", "iam:Untag*", "iam:SetDefaultPolicyVersion"]
    resources = concat(local.guarded_role_arns, local.guarded_policy_arns)
  }

  # The state key and bucket are this root's; CI only uses them.
  statement {
    sid       = "StateAliasAndBucketAreFixed"
    effect    = "Deny"
    actions   = ["kms:CreateAlias", "kms:UpdateAlias", "kms:DeleteAlias", "s3:DeleteBucket", "s3:PutBucket*", "s3:DeleteBucket*", "s3:PutEncryptionConfiguration", "s3:PutLifecycleConfiguration"]
    resources = ["arn:aws:kms:${var.aws_region}:${var.aws_account_id}:${local.state_key_alias}", local.state_bucket_arn]
  }

  statement {
    sid       = "StateKeyIsFixed"
    effect    = "Deny"
    actions   = ["kms:PutKeyPolicy", "kms:DisableKey", "kms:ScheduleKeyDeletion", "kms:DisableKeyRotation", "kms:TagResource", "kms:UntagResource", "kms:UpdateKeyDescription"]
    resources = ["arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/*"]

    condition {
      test     = local.state_key_by_alias.test
      variable = local.state_key_by_alias.variable
      values   = local.state_key_by_alias.values
    }
  }

  # Global services are exempt from the region check.
  statement {
    sid         = "OnlyTheDeploymentRegions"
    effect      = "Deny"
    not_actions = ["iam:*", "sts:*", "support:*"]
    resources   = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = distinct([var.aws_region, var.ses_region])
    }
  }
}

resource "aws_iam_policy" "boundary" {
  name        = local.boundary_name
  description = "Ceiling on psd-eoc's Terraform CI roles (psd-dev-standards 08 guardrail 3)."
  policy      = data.aws_iam_policy_document.boundary.json
}
