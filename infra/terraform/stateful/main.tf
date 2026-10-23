locals {
  # The CloudFormation parameter `PartnerUserPoolClientSecretArn` accepts only
  # this secret path, so the two names are one contract. Changing either
  # without the other makes every deploy fail validation.
  client_secret_name = "/psd-eoc/partner-user-pool-client"
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

  # The two sign-in methods the product owner decided on (2026-10-23). Password
  # is deliberately absent; the app client below also refuses every
  # password-bearing auth flow, so password sign-in stays impossible even if
  # Cognito keeps PASSWORD in a pool's own factor list.
  sign_in_policy {
    allowed_first_auth_factors = ["EMAIL_OTP", "WEB_AUTHN"]
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

  # Cognito's own mailbox, deliberately: this pool sends invitations and
  # one-time passwords only, and its daily allowance covers that. Moving
  # partner mail onto the district's SES identity is a separate change with its
  # own IAM grant and verified-identity prerequisite.
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  lifecycle {
    prevent_destroy = true
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
