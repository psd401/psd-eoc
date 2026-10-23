# Stateful AWS Terraform root

This is the first Terraform root for AWS in this repository, created by the
partner-access work and laid out as
[the CDK to Terraform migration plan](../../../docs/terraform-migration-plan.md)
describes. The migration later imports the existing stateful resources
(network, Aurora, KMS, S3, secret containers, SQS, SES configuration set, SMS
resources, ECR, log groups) into this same root, so nothing here is redone.

Today it holds one thing: the Cognito user pool for non-district first
responders, its server app client, and the Secrets Manager record of that
client's credential.

## Why a separate pool

District staff sign in through Google OIDC against the district directory. A
fire-district or police-department responder is not in that directory and never
will be, so admitting them there would mean weakening the staff boundary.
Instead they get their own pool, with:

- the Essentials feature plan, which is what makes passwordless sign-in
  available at all;
- email one-time passwords and WebAuthn passkeys as the only first factors,
  with every password flow left out of the app client;
- administrator invitation only — no self sign-up and no self-service
  recovery;
- no federation to any agency identity provider, and no hosted-UI domain.

## Operating this root

Every value is tenant configuration, so nothing in this directory is real. The
checked-in backend bucket is deliberately unusable, and the real one arrives
through `-backend-config`:

```sh
cd infra/terraform/stateful
terraform init -reconfigure -backend-config=/protected/path/backend.hcl
terraform plan -var-file=/protected/path/stateful.tfvars
```

Copy `backend.hcl.example` and `stateful.tfvars.example` outside the repository
first and replace every placeholder. Applying this root against the live
account is a product-owner action; nothing in the repository applies it.

The credential-free plan — what `bun run verify:terraform` and CI run — needs
no backend and no AWS credential at all:

```sh
terraform init -backend=false
terraform fmt -check
terraform validate
terraform test
```

## Handoff to the CloudFormation stack

Until the migration moves App Runner into Terraform, the three values the
server needs cross the boundary as CloudFormation parameters. `terraform
output stack_parameters` prints exactly the three, named as the stack's
parameters:

| Terraform output                      | Stack parameter                  |
| ------------------------------------- | -------------------------------- |
| `partner_user_pool_id`                | `PartnerUserPoolId`              |
| `partner_user_pool_client_id`         | `PartnerUserPoolClientId`        |
| `partner_user_pool_client_secret_arn` | `PartnerUserPoolClientSecretArn` |

All three default to `UNCONFIGURED` in the stack. Supplying none of them leaves
today's deployment exactly as it is; supplying some but not all is refused at
validation rather than producing a half-configured sign-in. See
[docs/CONFIGURATION.md](../../../docs/CONFIGURATION.md).

The client-secret ARN is a complete ARN including the generated suffix, and the
stack's allowed pattern accepts only the `/psd-eoc/partner-user-pool-client`
path this root creates. The two names are one contract.

## What this root's state contains

Cognito generates the app client's secret, so Terraform reads it back into
state as a computed attribute whether or not it writes the Secrets Manager
version. This root therefore writes the version too: omitting it would buy no
secrecy and would add a manual copy step that, if skipped, leaves the server
reading an empty secret. **Treat this root's state bucket as secret-bearing**:
versioning on, KMS encryption, public access blocked, and access limited to the
plan and apply roles. No output exposes the secret value.

Partner email addresses live in the pool, not in state. The
`psd:data-classification` tag is `partner-pii` for that reason.

## Email delivery

Email one-time passwords "require Essentials feature plan or higher and Amazon
SES email configuration"
([Cognito email settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html)),
so the pool sends through the district's SES identity (`DEVELOPER`), never
Cognito's own mailbox. The root:

- reads the existing domain identity named by `ses_identity_domain` (the stack's
  `psdEoc:sesIdentityDomain`) and refuses to plan if SES has not verified it
  for sending — the identity is shared with other district senders, so this
  root never owns it;
- creates Cognito's email service-linked role,
  `AWSServiceRoleForAmazonCognitoIdpEmailService`, which may only call
  `ses:SendEmail` and `ses:SendRawEmail`. It is one per account and outlives
  this pool. The apply role needs `iam:CreateServiceLinkedRole`, limited by
  `iam:AWSServiceName = email.cognito-idp.amazonaws.com` (approved
  2026-10-23; the role itself comes from `state-bootstrap`);
- sends from `partner_email_from_address`, which must be an address in that
  domain. The tenant uses the stack's own sender, `psdEoc:sesFromDisplayName`
  and `psdEoc:sesFromAddress` as `Name <address>` (product owner,
  2026-10-23), so partners see one sender for invitations, codes and alerts.

Before the first apply, the SES account in the pool's region must be out of the
sandbox; in the sandbox Cognito "can't send messages to your users' email
addresses" (same page). `infra/src/ops/ses-production-access.ts --check`
reports it read-only; see
[docs/runbooks/email-setup.md](../../../docs/runbooks/email-setup.md).

No SES configuration set is attached. The stack's `psd-eoc-transactional` set
publishes every event to the alert-delivery callback, which accepts only mail
carrying its own correlation tags; Cognito's mail carries none, so each
one-time-password email would be refused and land in the dead-letter queue.

## Changing the relying-party id

A passkey is bound to `passkey_relying_party_id`. Changing it after partners
have enrolled invalidates every enrolled passkey, and they all re-enroll. It is
the application's own hostname and should change only when that hostname does.
