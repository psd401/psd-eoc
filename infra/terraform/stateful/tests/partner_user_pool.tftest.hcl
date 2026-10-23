// Credential-free plan of this root. Mocked providers mean nothing is created,
// read, or authenticated, so this runs in `bun run check` and in CI.
mock_provider "aws" {}

variables {
  aws_account_id           = "123456789012"
  aws_region               = "us-east-2"
  environment              = "production"
  owner                    = "technology@example.invalid"
  source_repository_url    = "https://code.example.invalid/example/eoc"
  passkey_relying_party_id = "eoc.example.invalid"
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
      aws_cognito_user_pool.partner.sign_in_policy[0].allowed_first_auth_factors == toset(["EMAIL_OTP", "WEB_AUTHN"])
    )
    error_message = "Email OTP and WebAuthn passkeys must be the only first-factor sign-in methods."
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
    condition = join(",", sort(keys(output.stack_parameters))) == "PartnerUserPoolClientId,PartnerUserPoolClientSecretArn,PartnerUserPoolId"
    error_message = "The stack handoff must carry exactly the pool id, client id, and secret ARN."
  }
}

// A domain without a dot is not a deliverable owner address.
run "owner_requires_a_dotted_domain" {
  command = plan

  variables {
    owner = "technology@example"
  }

  expect_failures = [var.owner]
}
