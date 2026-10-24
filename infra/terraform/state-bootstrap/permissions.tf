# What the CI roles may do. Reads are what a plan of infra/terraform/stateful
# calls; changes are limited to psd-eoc's own resources by name, path or tag.
# When the migration imports more resources into the stateful root, this file
# grows with it, in the same pull request.

locals {
  pool_arn = "arn:aws:%s:${var.aws_region}:${var.aws_account_id}"
  ses_arn  = "arn:aws:%s:${var.ses_region}:${var.aws_account_id}"

  state_object_arns = [for key in values(local.state_keys) : "${local.state_bucket_arn}/${key}"]
  state_lock_arns   = [for key in values(local.state_keys) : "${local.state_bucket_arn}/${key}.tflock"]

  user_pool_arns         = ["${format(local.pool_arn, "cognito-idp")}:userpool/*"]
  configuration_set_arns = ["${format(local.ses_arn, "ses")}:configuration-set/psd-eoc-*"]
  topic_arns             = ["${format(local.ses_arn, "sns")}:psd-eoc-*"]
  subscription_arns      = ["${format(local.ses_arn, "sns")}:psd-eoc-*:*"]
  secret_arns            = ["${format(local.pool_arn, "secretsmanager")}:secret:/psd-eoc/partner-user-pool-client*"]
  key_arns               = ["${format(local.ses_arn, "kms")}:key/*", "${format(local.pool_arn, "kms")}:key/*"]
  cognito_email_role_arn = "arn:aws:iam::${var.aws_account_id}:role/aws-service-role/email.cognito-idp.amazonaws.com/*"

  psd_eoc_resource_tag = { test = "StringEquals", variable = "aws:ResourceTag/psd:application", values = ["psd-eoc"] }
  psd_eoc_request_tag  = { test = "StringEquals", variable = "aws:RequestTag/psd:application", values = ["psd-eoc"] }
}

data "aws_iam_policy_document" "read" {
  statement {
    sid       = "ReadTheStates"
    actions   = ["s3:GetObject"]
    resources = local.state_object_arns
  }

  # Unconditioned, as the S3 backend's documented policy is: the backend also
  # lists outside the state key (workspaces), and this bucket holds only
  # psd-eoc's states.
  statement {
    sid       = "ListTheStateBucket"
    actions   = ["s3:ListBucket"]
    resources = [local.state_bucket_arn]
  }

  statement {
    sid       = "DecryptTheStates"
    actions   = ["kms:Decrypt"]
    resources = ["${format(local.pool_arn, "kms")}:key/*"]

    condition {
      test     = local.state_key_by_alias.test
      variable = local.state_key_by_alias.variable
      values   = local.state_key_by_alias.values
    }
  }

  statement {
    sid       = "ReadTheUserPool"
    actions   = ["cognito-idp:DescribeUserPool", "cognito-idp:DescribeUserPoolClient", "cognito-idp:GetUserPoolMfaConfig", "cognito-idp:ListTagsForResource"]
    resources = local.user_pool_arns
  }

  statement {
    sid       = "ReadTheSesIdentityAndSets"
    actions   = ["ses:GetEmailIdentity", "ses:GetConfigurationSet", "ses:GetConfigurationSetEventDestinations", "ses:ListTagsForResource"]
    resources = concat(["${format(local.ses_arn, "ses")}:identity/*"], local.configuration_set_arns)
  }

  statement {
    sid       = "ReadTheTopics"
    actions   = ["sns:GetTopicAttributes", "sns:ListTagsForResource", "sns:ListSubscriptionsByTopic", "sns:GetSubscriptionAttributes"]
    resources = concat(local.topic_arns, local.subscription_arns)
  }

  statement {
    sid       = "ReadPsdEocKeys"
    actions   = ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags"]
    resources = local.key_arns

    condition {
      test     = local.psd_eoc_resource_tag.test
      variable = local.psd_eoc_resource_tag.variable
      values   = local.psd_eoc_resource_tag.values
    }
  }

  statement {
    sid       = "ListKeyAliases"
    actions   = ["kms:ListAliases"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadTheCognitoEmailRole"
    actions   = ["iam:GetRole"]
    resources = [local.cognito_email_role_arn]
  }

  # The stateful root writes the partner app-client secret version, so a
  # refresh reads it back. The state these roles read holds the same value,
  # which is why the plan role trusts only `main` (roles.tf): both are secret
  # material, and no unreviewed code may hold them.
  statement {
    sid       = "ReadThePartnerClientSecret"
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy", "secretsmanager:GetSecretValue", "secretsmanager:ListSecretVersionIds"]
    resources = local.secret_arns
  }
}

data "aws_iam_policy_document" "apply" {
  statement {
    sid       = "WriteTheStates"
    actions   = ["s3:PutObject"]
    resources = local.state_object_arns
  }

  statement {
    sid       = "HoldTheStateLocks"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = local.state_lock_arns
  }

  statement {
    sid       = "EncryptTheStates"
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = ["${format(local.pool_arn, "kms")}:key/*"]

    condition {
      test     = local.state_key_by_alias.test
      variable = local.state_key_by_alias.variable
      values   = local.state_key_by_alias.values
    }
  }

  # CreateUserPool names no resource (Service Authorization Reference,
  # Amazon Cognito user pools), so it cannot be scoped further than this.
  statement {
    sid       = "CreateTheUserPool"
    actions   = ["cognito-idp:CreateUserPool"]
    resources = ["*"]
  }

  statement {
    sid = "ChangeTheUserPool"
    actions = [
      "cognito-idp:UpdateUserPool", "cognito-idp:DeleteUserPool", "cognito-idp:SetUserPoolMfaConfig",
      "cognito-idp:CreateUserPoolClient", "cognito-idp:UpdateUserPoolClient", "cognito-idp:DeleteUserPoolClient",
      "cognito-idp:TagResource", "cognito-idp:UntagResource",
    ]
    resources = local.user_pool_arns
  }

  statement {
    sid       = "CreateTheCognitoEmailRole"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = [local.cognito_email_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["email.cognito-idp.amazonaws.com"]
    }
  }

  statement {
    sid = "ChangePsdEocConfigurationSets"
    actions = [
      "ses:CreateConfigurationSet", "ses:DeleteConfigurationSet",
      "ses:PutConfigurationSetDeliveryOptions", "ses:PutConfigurationSetReputationOptions",
      "ses:PutConfigurationSetSendingOptions", "ses:PutConfigurationSetSuppressionOptions",
      "ses:PutConfigurationSetTrackingOptions", "ses:PutConfigurationSetVdmOptions",
      "ses:CreateConfigurationSetEventDestination", "ses:UpdateConfigurationSetEventDestination",
      "ses:DeleteConfigurationSetEventDestination", "ses:TagResource", "ses:UntagResource",
    ]
    resources = local.configuration_set_arns
  }

  statement {
    sid       = "ChangePsdEocTopics"
    actions   = ["sns:CreateTopic", "sns:DeleteTopic", "sns:SetTopicAttributes", "sns:Subscribe", "sns:TagResource", "sns:UntagResource"]
    resources = local.topic_arns
  }

  statement {
    sid       = "ChangePsdEocSubscriptions"
    actions   = ["sns:Unsubscribe", "sns:SetSubscriptionAttributes"]
    resources = concat(local.topic_arns, local.subscription_arns)
  }

  # A key is created with its psd:application tag, and tagging at creation is
  # authorized as kms:TagResource on the new key, so both are allowed only
  # for a request that sets that tag.
  statement {
    sid       = "CreatePsdEocKeys"
    actions   = ["kms:CreateKey", "kms:TagResource"]
    resources = ["*"]

    condition {
      test     = local.psd_eoc_request_tag.test
      variable = local.psd_eoc_request_tag.variable
      values   = local.psd_eoc_request_tag.values
    }
  }

  statement {
    sid       = "ChangePsdEocKeys"
    actions   = ["kms:PutKeyPolicy", "kms:EnableKeyRotation", "kms:UpdateKeyDescription", "kms:ScheduleKeyDeletion", "kms:TagResource", "kms:UntagResource"]
    resources = local.key_arns

    condition {
      test     = local.psd_eoc_resource_tag.test
      variable = local.psd_eoc_resource_tag.variable
      values   = local.psd_eoc_resource_tag.values
    }
  }

  statement {
    sid       = "ChangeThePartnerClientSecret"
    actions   = ["secretsmanager:CreateSecret", "secretsmanager:DeleteSecret", "secretsmanager:UpdateSecret", "secretsmanager:PutSecretValue", "secretsmanager:TagResource", "secretsmanager:UntagResource"]
    resources = local.secret_arns
  }
}
