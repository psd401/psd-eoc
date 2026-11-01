# Stateful AWS Terraform root

This is the first Terraform root for AWS in this repository, created by the
partner-access work and laid out as
[the CDK to Terraform migration plan](../../../docs/terraform-migration-plan.md)
describes. The migration later imports the existing stateful resources
(network, Aurora, KMS, S3, secret containers, SQS, SES configuration set, SMS
resources, ECR, log groups) into this same root, so nothing here is redone.

Today it holds one thing: the Cognito user pool for non-district first
responders, its server app client, the Secrets Manager record of that
client's credential, and the SES configuration set, topic and key for the
pool's email.

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
first and replace every placeholder. Under psd-dev-standards 08 this root
applies only from CI: the merged change is planned on `main`, the
`production` environment approval gates the apply, and an OIDC role pinned to that
environment runs it. Nobody applies it locally. That pipeline is the
[Terraform workflow](../../../.github/workflows/terraform.yml), and its roles,
state bucket and key come from [state-bootstrap](../state-bootstrap/README.md),
which a person applies once before this root's first apply.

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

| `stack_parameters` key           | Value                                |
| -------------------------------- | ------------------------------------ |
| `PartnerUserPoolId`              | The partner user pool id             |
| `PartnerUserPoolClientId`        | The server app-client id             |
| `PartnerUserPoolClientSecretArn` | The client credential's complete ARN |

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
- relies on Cognito's email service-linked role,
  `AWSServiceRoleForAmazonCognitoIdpEmailService`, which may only call
  `ses:SendEmail` and `ses:SendRawEmail`. Cognito creates it itself when the
  pool is configured to send through SES, so the apply role needs
  `iam:CreateServiceLinkedRole`, limited by
  `iam:AWSServiceName = email.cognito-idp.amazonaws.com` (approved
  2026-10-23; the apply role itself comes from `state-bootstrap`). The role is
  one per account and outlives this pool. This root managed it until
  2026-11-01, when a `removed` block forgot it without deleting it: the first
  apply had created it but could not tag it, because default tags need
  `iam:TagRole`, and the tainted resource under `prevent_destroy` refused every
  later plan;
- sends from `partner_email_from_address`, which must be an address in that
  domain. The tenant uses the stack's own sender, `psdEoc:sesFromDisplayName`
  and `psdEoc:sesFromAddress` as `Name <address>` (product owner,
  2026-10-23), so partners see one sender for invitations, codes and alerts.

### Region

The identity is read in `ses_region`, which may differ from `aws_region`.
Cognito's
[region table](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html#user-pool-email-developer-region-mapping)
lets a us-east-2 pool, for example, send through an identity in us-east-2,
us-east-1, eu-west-1 or US West (Oregon), and `source_arn` is the
identity's ARN in that region. The district sends production mail from one
account and region only (psd-dev-standards 17 decision 1), which need not be
the pool's region; the example pairs a us-east-2 pool with a us-east-1
identity. The configuration set, topic and key below are regional and
live in `ses_region` with the identity, through the `aws.ses` provider.

Before the first apply, the SES account in `ses_region` must be out of the
sandbox; in the sandbox Cognito "can't send messages to your users' email
addresses" (same page). `infra/src/ops/ses-production-access.ts --check`
reports it read-only for the stack's region; see
[docs/runbooks/email-setup.md](../../../docs/runbooks/email-setup.md).

### Configuration set

The pool names its own SES configuration set, `psd-eoc-<environment>-cognito`
(psd-dev-standards 17 rule 10; product owner, 2026-10-23, question 17.4). It
replaces the earlier decision to attach no set:

- **Never `psd-eoc-transactional`.** That set publishes every event to the
  alert-delivery callback, which refuses any event without its own correlation
  tags. Cognito's mail carries none, so each one-time-password email would be
  refused and land in `psd-eoc-email-callback-dlq`.
- **Not the identity's default.** The shared identity's default set belongs to
  its owner (standard 17 rule 2). Naming a set keeps Cognito's mail off it.
- **Events reach a person.** An event destination publishes `BOUNCE`,
  `COMPLAINT` and `REJECT` to a KMS-encrypted SNS topic whose one subscriber is
  `owner`, by email. No code consumes the topic. The subscription starts
  pending: after the apply, the owner group confirms it from the message SNS
  sends, and the group must accept mail from outside the domain for that
  message to arrive.
- **Suppression stays on** for `BOUNCE` and `COMPLAINT`, stated on the set
  rather than inherited (standard 17 rule 8).

## Changing the relying-party id

`passkey_relying_party_id` must be the host part of the stack's
`psdEoc:applicationOrigin`; the server derives the same id from that origin
rather than reading a second copy, so the two must name one hostname.

A passkey is bound to `passkey_relying_party_id`. Changing it after partners
have enrolled invalidates every enrolled passkey, and they all re-enroll. It is
the application's own hostname and should change only when that hostname does.
