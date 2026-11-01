locals {
  # The CloudFormation parameter `PartnerUserPoolClientSecretArn` accepts only
  # this secret path, so the two names are one contract. Changing either
  # without the other makes every deploy fail validation.
  client_secret_name = "/psd-eoc/partner-user-pool-client"
}

# The district's sending identity is shared with every other district sender,
# so this root reads it rather than owning it (psd-dev-standards 17 rule 2).
# Planning fails here, before the pool changes, if the identity is missing or
# not yet verified for sending. It is read in ses_region, which may differ from
# the pool's region: Cognito's region table lets a pool send through an
# identity in another supported region, and the district sends production mail
# from one account and region only (standard 17 decision 1).
data "aws_sesv2_email_identity" "district" {
  provider = aws.ses

  email_identity = var.ses_identity_domain
}

data "aws_partition" "current" {}

locals {
  cognito_configuration_set_name = "psd-eoc-${var.environment}-cognito"
}

# Cognito's mail gets its own configuration set (standard 17 rule 10, approved
# 2026-10-23 as question 17.4). It is never the stack's psd-eoc-transactional
# set: that set's events feed the alert callback, which refuses any event
# without psd-eoc's correlation tags, so every Cognito email would land in the
# callback dead-letter queue. Naming a set explicitly also keeps Cognito's mail
# off whatever default the shared identity's owner sets.
#
# A configuration set is regional and must sit in the region of the identity
# Cognito sends through, so it, its topic and its key use the ses provider.
resource "aws_sesv2_configuration_set" "cognito" {
  provider = aws.ses

  configuration_set_name = local.cognito_configuration_set_name

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  # Suppression stays on, stated here rather than inherited (standard 17
  # rule 8): an address that hard-bounced or complained is not sent to again.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

# Bounce, complaint and reject events carry partner addresses, so the topic is
# encrypted with a key SES may use. The AWS-managed SNS key cannot be used: its
# policy cannot grant SES.
resource "aws_kms_key" "cognito_email_events" {
  provider = aws.ses

  description             = "Encrypts partner Cognito email bounce, complaint and reject events."
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministers"
        Effect    = "Allow"
        Principal = { AWS = "arn:${data.aws_partition.current.partition}:iam::${var.aws_account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "SesPublishesCognitoSetEvents"
        Effect    = "Allow"
        Principal = { Service = "ses.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource  = "*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = var.aws_account_id
            "aws:SourceArn"     = aws_sesv2_configuration_set.cognito.arn
          }
        }
      },
    ]
  })
}

# The topic's one subscriber is the deployment owner group, by email. No code
# consumes it: a person reads each bounce or complaint (standard 17 rule 10).
resource "aws_sns_topic" "cognito_email_events" {
  provider = aws.ses

  name              = "${local.cognito_configuration_set_name}-email-events"
  kms_master_key_id = aws_kms_key.cognito_email_events.arn
}

resource "aws_sns_topic_policy" "cognito_email_events" {
  provider = aws.ses

  arn = aws_sns_topic.cognito_email_events.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "SesPublishesCognitoSetEvents"
        Effect    = "Allow"
        Principal = { Service = "ses.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.cognito_email_events.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = var.aws_account_id
            "aws:SourceArn"     = aws_sesv2_configuration_set.cognito.arn
          }
        }
      },
    ]
  })
}

# Email subscriptions start pending: the owner group confirms from the message
# SNS sends after the apply, and its group settings must accept mail from
# outside the domain for that message to arrive.
resource "aws_sns_topic_subscription" "cognito_email_events_owner" {
  provider = aws.ses

  topic_arn = aws_sns_topic.cognito_email_events.arn
  protocol  = "email"
  endpoint  = var.owner
}

resource "aws_sesv2_configuration_set_event_destination" "cognito" {
  provider = aws.ses

  configuration_set_name = aws_sesv2_configuration_set.cognito.configuration_set_name
  event_destination_name = "owner-alert"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT", "REJECT"]

    sns_destination {
      topic_arn = aws_sns_topic.cognito_email_events.arn
    }
  }

  depends_on = [aws_sns_topic_policy.cognito_email_events]
}

# Cognito sends DEVELOPER-configured mail through its email service-linked
# role, AWSServiceRoleForAmazonCognitoIdpEmailService, which allows only
# ses:SendEmail and ses:SendRawEmail. Cognito creates that role itself when a
# pool is configured to send through SES, by console, CLI or API, as long as
# the caller may iam:CreateServiceLinkedRole (Cognito developer guide,
# using-service-linked-roles.html); the apply role may, for this service only.
#
# This root managed the role until 2026-11-01. Its first apply created it but
# then failed to tag it (the provider's default tags need iam:TagRole, which
# the apply role does not hold), leaving it tainted, and a tainted resource
# under prevent_destroy refuses every later plan. The role is one per account
# and outlives this pool, so the root forgets it without deleting it.
removed {
  from = aws_iam_service_linked_role.cognito_email

  lifecycle {
    destroy = false
  }
}

# Non-district first responders never appear in the district's Google
# directory, so they cannot be admitted through the staff sign-in. They get
# their own user pool: separate directory, separate credentials, and no
# federation to any agency identity provider.
#
# A user pool is stateful. It holds partner identities and their passkeys, and
# losing it means every partner re-enrolls, so it carries both AWS deletion
# protection and `prevent_destroy`.
resource "aws_cognito_user_pool" "partner" {
  name = "psd-eoc-partner"

  # Passwordless sign-in (email OTP) and passkeys are Essentials-tier or
  # higher features; on Lite the sign-in policy below is ignored.
  user_pool_tier      = "ESSENTIALS"
  deletion_protection = "ACTIVE"

  # Email is the identity. Nothing else identifies a partner: there is no
  # separate username to issue, recover, or leak.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # The one-time password *is* the first factor. A second factor on top of it
  # would be a second email to the same inbox.
  mfa_configuration = "OFF"

  # Admin-invite only. No partner self-registers, and the admin-invite plus
  # yearly expiry flow in the application is the only way in.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  # The two sign-in methods the product owner decided on (2026-10-23) are
  # EMAIL_OTP and WEB_AUTHN. CreateUserPool refuses a list without PASSWORD
  # ("Password should be configured as one of the allowed first auth factors",
  # production apply 2026-11-01), so it is listed, but no partner can use it:
  # the app creates every partner with AdminCreateUser and no password, never
  # sets one, and recovery is admin-only, so no partner holds a password; and
  # the app client below refuses every password-bearing auth flow.
  sign_in_policy {
    allowed_first_auth_factors = ["PASSWORD", "EMAIL_OTP", "WEB_AUTHN"]
  }

  # A passkey is bound to this relying-party id and to user verification, so a
  # stolen device without its biometric or PIN is not a credential.
  web_authn_configuration {
    relying_party_id  = var.passkey_relying_party_id
    user_verification = "required"
  }

  # Self-service recovery would be a second, weaker way in. An administrator
  # re-invites instead.
  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }

  # The district's own SES identity, not Cognito's mailbox. Email one-time
  # passwords "require Essentials feature plan or higher and Amazon SES email
  # configuration" (Cognito developer guide, user-pool-email.html), so with
  # COGNITO_DEFAULT the EMAIL_OTP factor above could never deliver a code.
  # Cognito sends through its email service-linked role (above); the SES account
  # must be out of the sandbox in ses_region before partners can be emailed.
  # source_arn is the identity's ARN in ses_region, which is what lets a pool
  # in another supported region send through it.
  email_configuration {
    email_sending_account = "DEVELOPER"
    source_arn            = data.aws_sesv2_email_identity.district.arn
    from_email_address    = var.partner_email_from_address
    configuration_set     = aws_sesv2_configuration_set.cognito.configuration_set_name
  }

  depends_on = [
    aws_sesv2_configuration_set_event_destination.cognito,
  ]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = data.aws_sesv2_email_identity.district.verified_for_sending_status
      error_message = "The SES identity is not verified for sending; Cognito cannot email partners from it."
    }
  }
}

# One confidential client, used only by the server. No hosted UI, no callback
# URLs, and no OAuth flows: nothing in a browser ever talks to this pool
# directly.
resource "aws_cognito_user_pool_client" "server" {
  name         = "psd-eoc-partner-server"
  user_pool_id = aws_cognito_user_pool.partner.id

  # The server holds the secret, so every call it makes is attributable to it
  # rather than to anyone who learned the client id.
  generate_secret = true

  # ALLOW_USER_AUTH is the choice-based flow that carries email OTP and
  # passkeys. Every password-bearing flow is left out on purpose.
  explicit_auth_flows = [
    "ALLOW_USER_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  supported_identity_providers = ["COGNITO"]

  # Explicit rather than left to API defaults. A failed sign-in never reveals
  # whether a partner address is enrolled, and refresh tokens stay revocable
  # so disabling a partner can end the sessions they already hold.
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  # Long enough for a partner to read an emailed code, short enough that an
  # abandoned sign-in cannot be resumed later.
  auth_session_validity = 3

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 1

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# The client secret reaches the server the same way every other credential
# does: as a Secrets Manager ARN the runtime role may read, never as a
# deployment value.
resource "aws_secretsmanager_secret" "partner_client" {
  name        = local.client_secret_name
  description = "Partner Cognito app-client credential read by the server at runtime."

  # The longest window Secrets Manager allows: a mistaken delete of the
  # credential every partner sign-in depends on stays restorable for 30 days.
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}

# Cognito generates this secret, so Terraform reads it back into state whether
# or not it writes this version; omitting the version would buy no secrecy and
# would add a manual copy step that can silently be skipped, leaving the server
# with an empty secret. The state bucket is therefore treated as
# secret-bearing. No output exposes the value.
resource "aws_secretsmanager_secret_version" "partner_client" {
  secret_id = aws_secretsmanager_secret.partner_client.id
  secret_string = jsonencode({
    clientId     = aws_cognito_user_pool_client.server.id
    clientSecret = aws_cognito_user_pool_client.server.client_secret
    userPoolId   = aws_cognito_user_pool.partner.id
  })

  # Rotating the credential rewrites this version in place; only tearing the
  # pool down would destroy it, which this root refuses like every other
  # stateful resource.
  lifecycle {
    prevent_destroy = true
  }
}
