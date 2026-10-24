# The GitHub Actions roles: a read-only one that plans `main`, and one that
# applies from the `production` environment after a reviewer approves
# (psd-dev-standards 08 PR flow 4). Both are assumed through the
# account's existing GitHub OIDC provider; no access key exists.

locals {
  plan_role_name  = "psd-eoc-${var.environment}-github-terraform-plan"
  apply_role_name = "psd-eoc-${var.environment}-github-terraform-apply"
  apply_role_arn  = "arn:aws:iam::${var.aws_account_id}:role/${local.apply_role_name}"
}

# The provider is account-wide and other repositories' roles already trust it,
# so this root reads it and never creates or changes it.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "plan_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Only `main`, never `pull_request`. A pull request can rewrite the
    # workflow it runs, and this role reads the stateful state, which holds the
    # partner app-client secret; a plan role a pull request could assume would
    # let any branch send that secret anywhere. So only reviewed, merged code
    # runs with AWS credentials, and the reviewer reads the plan in the main
    # run before approving its apply.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${var.github_subject_prefix}:ref:refs/heads/main"]
    }
  }
}

data "aws_iam_policy_document" "apply_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${var.github_subject_prefix}:environment:production"]
    }
  }
}

resource "aws_iam_role" "plan" {
  name                 = local.plan_role_name
  description          = "Plans psd-eoc's AWS Terraform from GitHub Actions on main; reads only."
  assume_role_policy   = data.aws_iam_policy_document.plan_trust.json
  permissions_boundary = local.boundary_arn
  max_session_duration = 3600

  # IAM refuses a boundary that does not exist yet.
  depends_on = [aws_iam_policy.boundary]
}

resource "aws_iam_role" "apply" {
  name                 = local.apply_role_name
  description          = "Applies psd-eoc's AWS Terraform from the GitHub production environment, after review."
  assume_role_policy   = data.aws_iam_policy_document.apply_trust.json
  permissions_boundary = local.boundary_arn
  max_session_duration = 3600

  # IAM refuses a boundary that does not exist yet.
  depends_on = [aws_iam_policy.boundary]
}

resource "aws_iam_policy" "read" {
  name        = "psd-eoc-${var.environment}-terraform-read"
  description = "What a plan of psd-eoc's AWS Terraform reads (both CI roles)."
  policy      = data.aws_iam_policy_document.read.json
}

resource "aws_iam_policy" "apply" {
  name        = "psd-eoc-${var.environment}-terraform-apply"
  description = "What psd-eoc's apply role may change: its own resources, by name or tag."
  policy      = data.aws_iam_policy_document.apply.json
}

resource "aws_iam_role_policy_attachment" "plan_read" {
  role       = aws_iam_role.plan.name
  policy_arn = aws_iam_policy.read.arn
}

resource "aws_iam_role_policy_attachment" "apply_read" {
  role       = aws_iam_role.apply.name
  policy_arn = aws_iam_policy.read.arn
}

resource "aws_iam_role_policy_attachment" "apply" {
  role       = aws_iam_role.apply.name
  policy_arn = aws_iam_policy.apply.arn
}
