// Credential-free plan of this root. Mocked providers mean nothing is created,
// read, or authenticated, so this runs in `bun run check` and in CI.
mock_provider "aws" {}

// The SES region differs from the pool's on purpose, as the district's does:
// a us-east-2 pool sending through a verified us-east-1 identity.
mock_provider "aws" {
  alias = "ses"

  mock_data "aws_sesv2_email_identity" {
    defaults = {
      arn                         = "arn:aws:ses:us-east-1:123456789012:identity/example.invalid"
      verified_for_sending_status = true
    }
  }
}

variables {
  aws_account_id             = "123456789012"
  aws_region                 = "us-east-2"
  ses_region                 = "us-east-1"
  environment                = "production"
  owner                      = "technology@example.invalid"
  source_repository_url      = "https://code.example.invalid/example/eoc"
  passkey_relying_party_id   = "eoc.example.invalid"
  ses_identity_domain        = "example.invalid"
  partner_email_from_address = "EOC Alerts <eoc-alerts@example.invalid>"
}

run "partner_pool_plan" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool.partner.user_pool_tier == "ESSENTIALS"
    error_message = "Passwordless email OTP and passkeys require the Essentials feature plan."
  }

  assert {
    condition = (
      length(aws_cognito_user_pool.partner.sign_in_policy) == 1 &&
      aws_cognito_user_pool.partner.sign_in_policy[0].allowed_first_auth_factors == toset(["PASSWORD", "EMAIL_OTP", "WEB_AUTHN"])
    )
    error_message = "Email OTP and WebAuthn passkeys are the sign-in methods; PASSWORD is listed only because CreateUserPool requires it."
  }

  assert {
    condition     = aws_cognito_user_pool.partner.admin_create_user_config[0].allow_admin_create_user_only == true
    error_message = "No partner may self sign up; the pool is admin-invite only."
  }

  assert {
    condition     = aws_cognito_user_pool.partner.deletion_protection == "ACTIVE"
    error_message = "The pool holds partner identities and passkeys, so deletion protection must stay on."
  }

  assert {
    condition     = aws_cognito_user_pool.partner.mfa_configuration == "OFF"
    error_message = "A one-time password to the same inbox is the first factor, not a second one."
  }

  assert {
    condition = (
      aws_cognito_user_pool.partner.web_authn_configuration[0].relying_party_id == "eoc.example.invalid" &&
      aws_cognito_user_pool.partner.web_authn_configuration[0].user_verification == "required"
    )
    error_message = "Passkeys must be bound to the configured relying party and require user verification."
  }

  assert {
    condition = (
      length(aws_cognito_user_pool.partner.account_recovery_setting[0].recovery_mechanism) == 1 &&
      one([for mechanism in aws_cognito_user_pool.partner.account_recovery_setting[0].recovery_mechanism : mechanism.name]) == "admin_only"
    )
    error_message = "Self-service recovery would be a second, weaker way in."
  }

  // No federation and no hosted UI: this root declares no
  // aws_cognito_user_pool_domain and no aws_cognito_identity_provider, and OTP
  // sign-in needs neither.
  assert {
    condition     = aws_cognito_user_pool_client.server.supported_identity_providers == toset(["COGNITO"])
    error_message = "The partner pool federates to no agency identity provider."
  }

  assert {
    condition     = aws_cognito_user_pool_client.server.explicit_auth_flows == toset(["ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"])
    error_message = "The app client must permit only choice-based and refresh flows, never a password flow."
  }

  assert {
    condition     = aws_cognito_user_pool_client.server.generate_secret == true
    error_message = "The server is a confidential client and needs its own secret."
  }

  // The CloudFormation parameter's allowed pattern accepts only this path.
  assert {
    condition     = aws_secretsmanager_secret.partner_client.name == "/psd-eoc/partner-user-pool-client"
    error_message = "The client-secret path is a contract with the PsdEoc stack parameter."
  }

  // The identifiers themselves are only known after an apply, so the plan
  // asserts the handoff's shape: exactly the three parameters the stack reads,
  // and no fourth value such as the secret itself.
  assert {
    condition     = join(",", sort(keys(output.stack_parameters))) == "PartnerUserPoolClientId,PartnerUserPoolClientSecretArn,PartnerUserPoolId"
    error_message = "The stack handoff must carry exactly the pool id, client id, and secret ARN."
  }

  // Email one-time passwords need the pool's own SES configuration; Cognito's
  // default mailbox cannot send them.
  assert {
    condition = (
      aws_cognito_user_pool.partner.email_configuration[0].email_sending_account == "DEVELOPER" &&
      aws_cognito_user_pool.partner.email_configuration[0].source_arn == "arn:aws:ses:us-east-1:123456789012:identity/example.invalid" &&
      aws_cognito_user_pool.partner.email_configuration[0].from_email_address == "EOC Alerts <eoc-alerts@example.invalid>"
    )
    error_message = "Partner email must go through the district's verified SES identity in ses_region."
  }

  // psd-dev-standards 17 rule 10: the pool's own set, never the stack's
  // tagged psd-eoc-transactional set, whose callback refuses untagged mail.
  assert {
    condition = (
      aws_cognito_user_pool.partner.email_configuration[0].configuration_set == "psd-eoc-production-cognito" &&
      aws_sesv2_configuration_set.cognito.configuration_set_name == "psd-eoc-production-cognito"
    )
    error_message = "The partner pool must name its own psd-eoc-<env>-cognito configuration set."
  }

  assert {
    condition     = aws_cognito_user_pool.partner.email_configuration[0].configuration_set != "psd-eoc-transactional"
    error_message = "Cognito mail must never use the alert set; its callback refuses untagged events."
  }

  assert {
    condition     = toset(aws_sesv2_configuration_set.cognito.suppression_options[0].suppressed_reasons) == toset(["BOUNCE", "COMPLAINT"])
    error_message = "Suppression stays on for bounces and complaints (standard 17 rule 8)."
  }

  assert {
    condition = (
      aws_sesv2_configuration_set_event_destination.cognito.event_destination[0].enabled == true &&
      aws_sesv2_configuration_set_event_destination.cognito.event_destination[0].matching_event_types == toset(["BOUNCE", "COMPLAINT", "REJECT"]) &&
      length(aws_sesv2_configuration_set_event_destination.cognito.event_destination[0].sns_destination) == 1
    )
    error_message = "Bounce, complaint and reject events must reach the owner topic."
  }

  assert {
    condition = (
      aws_sns_topic_subscription.cognito_email_events_owner.protocol == "email" &&
      aws_sns_topic_subscription.cognito_email_events_owner.endpoint == "technology@example.invalid"
    )
    error_message = "The owner group is the topic's one subscriber, by email."
  }
}

// An identity that SES has not verified would leave every partner without a
// code, so the plan stops before touching the pool.
run "unverified_ses_identity_is_refused" {
  command = plan

  override_data {
    target = data.aws_sesv2_email_identity.district
    values = {
      arn                         = "arn:aws:ses:us-east-1:123456789012:identity/example.invalid"
      verified_for_sending_status = false
    }
  }

  expect_failures = [aws_cognito_user_pool.partner]
}

// The From address must belong to the identity Cognito sends with.
run "from_address_outside_identity_is_refused" {
  command = plan

  variables {
    partner_email_from_address = "eoc-alerts@elsewhere.invalid"
  }

  expect_failures = [var.partner_email_from_address]
}

// A domain without a dot is not a deliverable owner address.
run "owner_requires_a_dotted_domain" {
  command = plan

  variables {
    owner = "technology@example"
  }

  expect_failures = [var.owner]
}
