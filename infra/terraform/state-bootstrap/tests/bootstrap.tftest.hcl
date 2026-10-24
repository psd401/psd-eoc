// Credential-free plan of the bootstrap root. The provider is real so the IAM
// policy documents are computed exactly as AWS will receive them, but it has
// fake keys and every call to AWS is skipped; the one data source that would
// call AWS is overridden. Nothing is created, read, or authenticated.
provider "aws" {
  region                      = "us-east-2"
  access_key                  = "mock-access-key"
  secret_key                  = "mock-secret-key"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

override_data {
  target = data.aws_iam_openid_connect_provider.github
  values = {
    arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  }
}

variables {
  aws_account_id        = "123456789012"
  aws_region            = "us-east-2"
  ses_region            = "us-east-1"
  environment           = "production"
  owner                 = "technology@example.invalid"
  source_repository_url = "https://code.example.invalid/example/eoc"
  github_subject_prefix = "repo:example@1234567/eoc@7654321"
  break_glass_role_arns = ["arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Administrator_0123456789abcdef"]
}

run "apply_role_trusts_only_the_production_environment" {
  command = plan

  assert {
    condition     = jsondecode(data.aws_iam_policy_document.apply_trust.json).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example@1234567/eoc@7654321:environment:production"
    error_message = "Only a job in the production environment, which needs a reviewer's approval, may apply."
  }

  assert {
    condition     = jsondecode(data.aws_iam_policy_document.apply_trust.json).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "The GitHub token must be minted for AWS STS."
  }

  assert {
    condition     = jsondecode(data.aws_iam_policy_document.apply_trust.json).Statement[0].Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    error_message = "Only GitHub's OIDC provider may assume the apply role."
  }
}

run "plan_role_trusts_main_only" {
  command = plan

  assert {
    condition = toset(flatten([jsondecode(data.aws_iam_policy_document.plan_trust.json).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]])) == toset([
      "repo:example@1234567/eoc@7654321:ref:refs/heads/main",
    ])
    error_message = "The plan role reads secret-bearing state, so only merged code on main may assume it; a pull request can rewrite its own workflow."
  }
}

run "both_roles_carry_the_boundary_and_short_sessions" {
  command = plan

  assert {
    condition     = aws_iam_role.apply.permissions_boundary == local.boundary_arn && aws_iam_role.plan.permissions_boundary == local.boundary_arn
    error_message = "Every CI role carries the boundary (psd-dev-standards 08 guardrail 3)."
  }

  assert {
    condition     = aws_iam_role.apply.max_session_duration == 3600 && aws_iam_role.plan.max_session_duration == 3600
    error_message = "CI sessions last at most an hour."
  }
}

run "plan_role_only_reads" {
  command = plan

  assert {
    condition = alltrue([
      for action in flatten([for s in jsondecode(data.aws_iam_policy_document.read.json).Statement : flatten([s.Action])]) :
      can(regex("^(s3:(GetObject|ListBucket)|kms:(Decrypt|Describe.*|Get.*|List.*)|[a-z-]+:(Describe|Get|List).*)$", action))
    ])
    error_message = "The read policy, the plan role's only policy, may only read."
  }

  assert {
    condition     = aws_iam_role_policy_attachment.plan_read.role == aws_iam_role.plan.name && aws_iam_role_policy_attachment.apply.role == aws_iam_role.apply.name
    error_message = "The plan role has the read policy; only the apply role has the apply policy."
  }
}

run "boundary_denies_what_no_ci_role_may_do" {
  command = plan

  assert {
    condition = alltrue([
      for action in ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateRole", "iam:AttachRolePolicy", "cloudtrail:StopLogging", "organizations:*"] :
      contains(flatten([for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement : s.Effect == "Deny" ? flatten([try(s.Action, [])]) : []]), action)
    ])
    error_message = "No users, keys, new roles or grants, audit changes, or organization changes."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(data.aws_iam_policy_document.boundary.json).Statement :
      s.Sid == "OnlyTheDeploymentRegions" && toset(flatten([s.Condition.StringNotEquals["aws:RequestedRegion"]])) == toset(["us-east-2", "us-east-1"])
    ])
    error_message = "CI acts only in the pool's and the SES identity's regions."
  }
}

run "apply_role_may_create_only_the_cognito_email_service_role" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(data.aws_iam_policy_document.apply.json).Statement :
      s.Sid == "CreateTheCognitoEmailRole" && s.Condition.StringEquals["iam:AWSServiceName"] == "email.cognito-idp.amazonaws.com"
    ])
    error_message = "The one role CI creates is Cognito's email service-linked role."
  }
}

run "state_bucket_is_versioned_encrypted_private_and_retained" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "psd-eoc-tfstate-123456789012"
    error_message = "The bucket name is fixed so every backend can name it."
  }

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "State bucket versioning stays on (psd-dev-standards 08 State rules)."
  }

  assert {
    condition     = one([for r in aws_s3_bucket_server_side_encryption_configuration.state.rule : one(r.apply_server_side_encryption_by_default).sse_algorithm]) == "aws:kms"
    error_message = "State is KMS-encrypted."
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.state.block_public_acls &&
      aws_s3_bucket_public_access_block.state.block_public_policy &&
      aws_s3_bucket_public_access_block.state.ignore_public_acls &&
      aws_s3_bucket_public_access_block.state.restrict_public_buckets
    )
    error_message = "Public access to state is blocked."
  }

  assert {
    condition     = aws_kms_key.state.enable_key_rotation
    error_message = "The state key rotates."
  }
}

run "only_ci_apply_and_break_glass_write_state" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(data.aws_iam_policy_document.state_bucket.json).Statement :
      s.Sid == "OnlyItsWritersChangeStatefulState" && s.Effect == "Deny" &&
      toset(flatten([s.Condition.ArnNotEquals["aws:PrincipalArn"]])) == toset([
        "arn:aws:iam::123456789012:role/psd-eoc-production-github-terraform-apply",
        "arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Administrator_0123456789abcdef",
      ])
    ])
    error_message = "Only the apply role and break-glass may write the stateful state (psd-dev-standards 08 State rules)."
  }
}
