---
type: Operations Guide
title: AWS CDK infrastructure, deployment, and monitoring
description: The single PsdEoc CDK stack (App Runner web, Aurora, SQS queues, ECS channel workers, Lambdas, media and records storage), the psd-dev-standards 08 deployment split (local direct cdk deploy, CI-only Terraform apply behind the production environment), bootstrap-before-promotion ordering, CloudWatch monitoring, and the Google Cloud identity project.
tags: [aws, cdk, deployment, monitoring, cloudwatch, terraform, lambda, cognito, partner-access]
timestamp: 2026-10-23T20:32:53-07:00
openwiki:
  roles: [operations, architecture, delivery]
  change_kinds: [infrastructure, deployment, monitoring, identity]
  source_paths:
    - infra/src/stack/psd-eoc-stack.ts
    - infra/src/stack/config.ts
    - infra/src/monitoring.ts
    - infra/src/config.ts
    - infra/src/tenant-context.ts
    - infra/src/source-revision.ts
    - infra/bin/psd-eoc.ts
    - infra/bin/synthesize-example.ts
    - infra/lambda
    - infra/gcp
    - infra/terraform/stateful
    - infra/src/ops/ses-production-access.ts
    - infra/src/ops/ses-verification.ts
    - infra/src/ops/ses-common.ts
    - scripts/verify-terraform.ts
    - packages/server/scripts/operations/bootstrap.ts
  symbols: [PsdEocStack, readDeploymentTarget, readTenantContext, configureInfrastructureMonitoring, configureMonitoring, APPLICATION_IMAGE_EXCLUDES, ShouldUsePartnerUserPool, AppRunnerPartnerUserPoolAccess, SES_MAIL_FROM_DOMAIN, SES_REQUIRED_EVENT_TYPES, configurationSetFailures]
  test_paths:
    - infra/test/stack/psd-eoc-stack.test.ts
    - infra/test/tenant-context.test.ts
    - infra/test/monitoring-runtime.test.ts
    - infra/test/delivery-router-runtime.test.ts
    - infra/test/bootstrap-deployment-runtime.test.ts
    - infra/test/source-revision.test.ts
    - infra/terraform/stateful/tests/partner_user_pool.tftest.hcl
    - infra/test/ses-operations.test.ts
  invariants:
    - The CDK stack is deployed only by a human's direct cdk deploy from a locally authenticated, short-lived AWS session; no workflow deploys CDK, CloudFormation, App Runner, or a container image.
    - Terraform roots apply only from CI behind the GitHub production environment approval, through an OIDC role pinned to that environment (psd-dev-standards 08); the one local apply is the one-time state-bootstrap run by the product owner.
    - CloudFormation promotes web and worker services only after the bootstrap task exits successfully.
    - Tenant identity lives in git-ignored infra/cdk.local.json, never in source.
    - Alarms that treat missing data as breaching are deployed only with a publisher.
    - Partner user pool access is granted only when all three PartnerUserPool* parameters are supplied; a partial set fails validation.
    - The Terraform root's only handoff output is stack_parameters, keyed by the stack's PartnerUserPool* parameter names; the run partner_pool_plan asserts that exact key set.
    - Partner email is sent only through the district's SES identity (DEVELOPER), read in ses_region; the plan refuses an identity that is not verified for sending, and a From address outside ses_identity_domain.
    - The partner pool names its own configuration set, psd-eoc-<environment>-cognito, and never the stack's psd-eoc-transactional set, whose callback refuses untagged mail.
    - The shared identity's MAIL FROM is bounce.<identity domain>, never mail.; the identity owner sets it, and psd-eoc never sets the identity's default configuration set.
    - Partner account mail names psd-eoc-production-partner, never psd-eoc-transactional; its bounce, complaint and reject events are mailed to operations and never texted.
    - The partner client secret is passed to the runtime only as an ARN and is never a service environment value or stack output.
  validation_commands:
    - bun run --cwd infra synth:example
    - bun test infra/test/stack/psd-eoc-stack.test.ts
    - bun run verify:terraform
---

# AWS CDK infrastructure, deployment, and monitoring

Read this before changing `infra/`, queue/worker wiring, alarms, or deploy behavior. Value-level parameter catalog: [configuration and readiness](configuration-and-readiness.md). Runtime consumers: [notification pipeline](../domain/notification-pipeline.md), [channel workers](../integrations/channel-workers.md), [architecture overview](../architecture/overview.md).

## Stack contents (`infra/src/stack/psd-eoc-stack.ts`, one `PsdEocStack`, ~3,900 lines)

- **Web:** AWS App Runner service from a content-addressed CDK image asset (resolved to an immutable ECR digest) through a VPC connector; two warm instances (min 2, max 4), per-key agent limits therefore multiply ×4 at most ([agent API](../integrations/agent-api-and-mcp.md)). Next.js is served on Node.
- **Data:** Aurora PostgreSQL (private, DB and application secrets in Secrets Manager); security groups for the app connector, database and workers.
- **Queues:** a single delivery queue + DLQ, per-channel queues (email, push, SMS) with DLQs, a health queue, and a separate SES callback queue + DLQ. The `delivery-router` Lambda fans the delivery queue to channel queues ([pipeline](../domain/notification-pipeline.md)).
- **Workers (ECS):** push worker service, SMS worker service, email worker service, email callback worker service, plus a scheduled access-membership-sync ECS task (`accessSyncSchedule`) and a bootstrap task. Per-worker secrets (`deliveryStateWorkerSecret`, `attemptExecutionWorkerSecret`, `pushEndpointWorkerSecret`, `expoPushRuntimeWorkerSecret`, `emailRuntimeWorkerSecret`, `smsRuntimeWorkerSecret`) are the scoped credentials for the internal routes. Provider-live behavior is gated by CloudFormation parameters/conditions (protected activation boundaries in `docs/CONFIGURATION.md`).
- **SES/SMS:** SES configuration set, event destination, SNS topic → callback queue; a second set for partner account mail with its own event topic ([partner account mail](#partner-account-mail-configuration-set)); AWS End User Messaging pool, opt-out list, protect configuration and an EventBridge rule for delivery events; an SMS opt-out schedule.
- **Storage:** private media bucket with an optional GuardDuty Malware Protection plan (role has a CFN condition because plan creation validates bucket ownership).
- **Operations:** KMS-encrypted operations/critical/recovery alarm topics, `alarm-mailer` Lambda (sends alarm email via SES instead of SNS email subscriptions, which can silently deactivate; it also mails partner account mail's bounce, complaint and reject events), `bootstrap-deployment` custom-resource Lambdas (start/check bootstrap, rollback image validation and quiescence), `failover-metric`, `metrics-collector`, `canary`.
- **Partner access (optional):** three `PartnerUserPool*` parameters (pool id, app-client id, client-secret ARN) default to `UNCONFIGURED`. Supplying all three sets the `ShouldUsePartnerUserPool` condition, which enables the `AppRunnerPartnerUserPoolAccess` policy (scoped Cognito actions on the one named pool, and `secretsmanager:GetSecretValue` on the one ARN) and the three `PSD_EOC_PARTNER_USER_POOL_*` runtime variables. The pool itself is not in this stack; see [partner first-responder directory](#partner-first-responder-directory-terraform-stateful-root). The web and sweep tasks also receive `PSD_EOC_SES_CONFIGURATION_SET_NAME`, a reference to the partner mail set described [below](#partner-account-mail-configuration-set).
- Other resources: ECR repository, optional custom domain, Google OIDC/cookie/API-salt secrets, Expo token and direct APNs/FCM credential secrets.

## Deploy model and ordering

```mermaid
sequenceDiagram
  participant Op as Operator (local SSO shell)
  participant CDK as bun run --cwd infra deploy
  participant CF as CloudFormation
  participant BS as Bootstrap ECS task
  participant Svc as App Runner and workers
  Op->>CDK: deploy PsdEoc with parameters
  CDK->>CDK: refuse dirty worktree, derive Git revision
  CDK->>CF: publish image asset, submit template
  CF->>BS: run bootstrap (migrate, access group, facilities)
  BS-->>CF: exit 0
  CF->>Svc: promote services and schedules
```

Caption: promotion is gated on bootstrap success (`bootstrap-deployment` Lambda + `scripts/operations/bootstrap.ts`).

- **Two deployment paths, one per tool** (psd-dev-standards 08, recorded in [AGENTS.md](../../AGENTS.md) §5–6 and [docs/CONFIGURATION.md](../../docs/CONFIGURATION.md) "Direct CDK deployment boundary"):
  - **CDK** deploys only when a human runs `infra/package.json` `deploy` from a locally authenticated, short-lived AWS session. No workflow deploys the stack. Agents prepare the pinned worktree and `cdk diff`, then hand the command to a human.
  - **Terraform** applies only from CI, after a pull request shows the plan and the GitHub `production` environment approval gates the apply. The OIDC role is pinned to that environment, and nobody applies Terraform from a laptop. This pipeline is phase 1 of the [migration plan](../../docs/terraform-migration-plan.md) and is not built, so no Terraform root is applied today.
- `infra/package.json` `deploy` sets `PSD_EOC_ENFORCE_DEPLOYMENT_TARGET=true`; `readDeploymentTarget` (`infra/src/stack/config.ts`) verifies account, region and origin; `source-revision.ts` embeds the exact commit and refuses dirty trees. There is **no** build/push/migrate/promote command. `.github/workflows` only verifies and synthesizes, and it does not deploy the stack.
- Rollback and bootstrap images are deliberately separate (`docs/learnings/workflow/2026-08-22-separate-rollback-and-bootstrap-images.md`); rollback procedure: `docs/runbooks/rollback.md`, release: `docs/runbooks/release.md`.
- Tenant context: committed `infra/cdk.json` (feature flags, threats, synthetic groups) plus git-ignored `infra/cdk.local.json` (shape `cdk.local.example.json`); `tenant-context.ts` `readTenantContext` merges them. `bin/synthesize-example.ts` builds a second reserved district to prove portability without credentials.

## Monitoring (`infra/src/monitoring.ts`)

Two entry points: `configureInfrastructureMonitoring` (live; alarms on AWS-published metrics for App Runner, Aurora, each queue/DLQ, plus conditional log-derived worker metrics) and `configureMonitoring` (adds the one-minute canary, metrics collector and alarms on what they publish; not wired live until the canary credential and `psd_eoc_monitoring` DB login exist). Missing-data-as-breaching alarms must never be deployed without their publisher. Alarm descriptions append runbook anchors to `psdEoc:monitoringRunbookBaseUrl`; `infra/README.md` headings are those anchors, so preserve them. Runbooks: `docs/runbooks/alarm-*.md`.

## Partner account mail configuration set

Partner account mail (the invitation, the yearly expiry notice and the administrators' quarterly review, described in [partner mail](../domain/partner-access.md#partner-mail)) is sent by the web task and the sweep task, not by the email worker. It names its own configuration set, `psd-eoc-production-partner` (`SES_PARTNER_CONFIGURATION_SET_NAME` in `infra/src/config.ts`). It cannot be the shared `psd-eoc-transactional` set, whose callback refuses mail without alert tags, and it must not fall to the identity owner's default set (psd-dev-standards 17 rule 7).

In `infra/src/stack/psd-eoc-stack.ts` (`PsdEocStack`) the stack creates:

- `PartnerEmailConfigurationSet`, with reputation metrics and sending enabled, retained on delete.
- `PartnerEmailEventsTopic` (`psd-eoc-production-partner-email-events`, SSL enforced), whose policy lets only `ses.amazonaws.com` publish, and only for this set's ARN.
- `PartnerEmailConfigurationSetEventDestination` (`owner-alert`), enabled, publishing `BOUNCE`, `COMPLAINT` and `REJECT` to that topic.

The topic is passed to monitoring as `MonitoringProps.partnerEmailEventsTopic` (`infra/src/monitoring.ts`). `configureAlarmRecipients` subscribes the `alarm-mailer` Lambda to it on a mail-only route, the same route as the recovery topic. Each event therefore reaches the operations mailbox as mail and is never texted. No code consumes the events, and the topic is unencrypted for the same reason as the alarm topics, since an event names only a partner address and the message subject.

The `SendOnlyPartnerAccountEmail` statement (`ses:SendEmail`, limited to `ses:FromAddress`) names the sender identity and this set, on both the web task's and the sweep task's policies. Both tasks receive `PSD_EOC_SES_CONFIGURATION_SET_NAME` as a `Ref` to the set, which orders them after it. `infra/test/stack/psd-eoc-stack.test.ts` pins both: the grant names the set and not `psd-eoc-transactional`, and the runtime variable is a reference to `PartnerEmailConfigurationSet`.

## Google Cloud identity (`infra/gcp`)

Terraform defines the Google project/APIs, the read-only Groups reader service account and least-privilege bindings; `scripts/run-guarded.sh` is the only supported launcher (pins operator env, validates project and AWS caller). `firebase/` is an isolated Terraform root for Android FCM, tested offline in `infra/test/gcp`. Credentials never enter Terraform state or the repo. See [identity](../domain/identity-and-access.md) for how the Groups reader is used. The migration plan below leaves these roots unchanged.

## Partner first-responder directory (Terraform stateful root)

Non-district first responders (fire districts, police departments) are not in the district's Google directory, so they cannot be admitted through staff sign-in without weakening the staff boundary ([identity and access](../domain/identity-and-access.md)). Their identities live in a separate Amazon Cognito user pool, defined in the first AWS Terraform root, `infra/terraform/stateful` ([its README](../../infra/terraform/stateful/README.md)). Under psd-dev-standards 08 this root applies only from CI, behind the GitHub `production` environment approval; that pipeline is phase 1 of the [migration plan](#proposed-terraform-migration-not-started) and is not built, so the root is not applied yet. `scripts/verify-terraform.ts` (`bun run verify:terraform`) checks it credential-free.

What the root declares (`main.tf`):

- `aws_cognito_user_pool.partner`: Essentials tier, email as the only identity, `EMAIL_OTP` and `WEB_AUTHN` as the only first factors, `mfa_configuration = "OFF"`, admin-invite only, passkeys bound to a relying-party id with `user_verification = "required"`, admin-only recovery, `DEVELOPER` mail through the district SES identity (see [email delivery](#email-delivery-developer-ses-identity)), and no hosted-UI domain or federation. Deletion protection and `prevent_destroy` are set.
- `aws_cognito_user_pool_client.server`: one confidential client (`generate_secret = true`), `ALLOW_USER_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH` only, so no password flow exists.
- `aws_secretsmanager_secret.partner_client` at the fixed path `/psd-eoc/partner-user-pool-client`, and `aws_secretsmanager_secret_version.partner_client`, which stores the client id, the client secret, and the pool id as JSON.
- `aws_iam_service_linked_role.cognito_email` (`email.cognito-idp.amazonaws.com`): the account-wide role Cognito uses to send through SES. It has `prevent_destroy`, because deleting it would stop every SES-backed user pool in the account.
- The pool's own mail path, all in the `ses` provider region (`ses_region`): `aws_sesv2_configuration_set.cognito` (`psd-eoc-<environment>-cognito`, reputation metrics on, sending on, suppression for `BOUNCE` and `COMPLAINT`), `aws_sesv2_configuration_set_event_destination.cognito` (`owner-alert`, enabled, publishing `BOUNCE`, `COMPLAINT` and `REJECT` to SNS), `aws_sns_topic.cognito_email_events` with its policy, `aws_sns_topic_subscription.cognito_email_events_owner` (protocol `email`, endpoint `owner`), and `aws_kms_key.cognito_email_events`. Details in [configuration set](#configuration-set-for-cognito-mail) below.
- Input `owner` (the `psd:owner` tag) must be an email address whose domain has at least one dot (`variables.tf`). A dotless address such as `technology@example` is refused at validation; the mocked run `owner_requires_a_dotted_domain` pins this.

The root's `outputs.tf` has one output, `stack_parameters`, keyed by the stack's own parameter names: `PartnerUserPoolId`, `PartnerUserPoolClientId`, and `PartnerUserPoolClientSecretArn`. It is the only handoff; the earlier standalone outputs and the unused pool ARN output were removed, so nothing downstream reads them. No output carries the secret value.

### Email delivery (DEVELOPER, SES identity)

Email one-time passwords require the pool's own SES configuration, so Cognito's default mailbox could never deliver a code. The pool therefore sends through the district's SES identity, and the root has these inputs and checks:

- `ses_identity_domain` names the existing SES domain identity (the stack's `psdEoc:sesIdentityDomain`). The root reads it with `data "aws_sesv2_email_identity"` and never owns it, because other district senders share it. The pool's `precondition` refuses the plan when the identity is not `verified_for_sending_status`.
- `ses_region` is the region that holds that identity, through the `aws.ses` provider alias (`providers.tf`). It may differ from `aws_region`: Cognito's region table lets a pool send through an identity in another supported region, and the district sends production mail from one account and region only (psd-dev-standards 17 decision 1). The example pairs a us-east-2 pool with a us-east-1 identity (`stateful.tfvars.example`). `source_arn` is the identity's ARN in `ses_region`.
- `partner_email_from_address` is the From address, optionally `Name <address>`. Its validation requires the address to end in `@` plus `ses_identity_domain`, so the From address must come from the identity Cognito sends with. `infra/terraform/stateful/stateful.tfvars.example` shows the placeholder shape; real values stay in a file outside the repository.
- The pool's `depends_on` orders creation after the service-linked role and after the Cognito configuration set's event destination. The apply role needs `iam:CreateServiceLinkedRole`, limited by `iam:AWSServiceName = email.cognito-idp.amazonaws.com`; the migration plan records that grant, but the `state-bootstrap` root that would carry it is not in the repository yet.
- Before the first real send, the SES account in `ses_region` must be out of the sandbox, because in the sandbox Cognito cannot email unverified recipients. `scripts/ops/ses-production-access.ts` (source `infra/src/ops/ses-production-access.ts`) with `--check --confirm-account <id> --confirm-region <region>` reports this read-only for the stack's region (`TARGET_REGION`), so confirm `ses_region` separately; see [email setup runbook](../../docs/runbooks/email-setup.md).

#### Configuration set for Cognito mail

The pool names its own configuration set, `psd-eoc-<environment>-cognito` (psd-dev-standards 17 rule 10). It is never the stack's `psd-eoc-transactional` set, whose events feed the alert-delivery callback. That callback accepts only mail with psd-eoc's correlation tags, so every Cognito one-time-password email would be refused and land in the dead-letter queue. Naming the set also keeps Cognito's mail off whatever default the identity's owner sets. The event flow is:

```mermaid
flowchart LR
  Cog["Cognito partner pool (DEVELOPER mail)"] -->|"sends via identity in ses_region, names set"| Set["SES set psd-eoc-env-cognito"]
  Set -->|"event destination owner-alert: BOUNCE, COMPLAINT, REJECT"| Topic["SNS topic (KMS encrypted)"]
  Topic -->|"email subscription, pending until confirmed"| Owner["owner group mailbox"]
```

Caption: no code consumes the topic. A person reads each bounce, complaint or reject and acts on it. The KMS key policy lets SES use the key only when the source account and the configuration set ARN match, because the AWS-managed SNS key cannot grant SES access.

The subscription starts pending. After the apply, the owner group confirms it from the message SNS sends, and the group must accept mail from outside the domain for that message to arrive. Suppression for `BOUNCE` and `COMPLAINT` is stated on the set rather than inherited (standard 17 rule 8).

#### SES readiness check

The source is `infra/src/ops/ses-verification.ts`. `scripts/ops/ses-verification.ts` is a thin entry point that calls its `verificationMain`. Its `--check` mode is read-only and verifies, for the shared identity in the stack's region: the account can send, the identity is a verified domain with DKIM `SUCCESS`, and its MAIL FROM is `bounce.<identity domain>` (`SES_MAIL_FROM_DOMAIN`, never `mail.`). A MAIL FROM that the identity owner has not set yet counts as not ready and is named "not set up", not as a mismatch. It also checks both sets psd-eoc names explicitly, the alert set `psd-eoc-transactional` and the partner set `psd-eoc-production-partner` (`CHECKED_CONFIGURATION_SET_NAMES`, read by `readSourceReadiness`): each must exist, have sending enabled, and have an enabled destination publishing every type in `SES_REQUIRED_EVENT_TYPES` (`BOUNCE`, `COMPLAINT`, `REJECT`), with suppression on. `configurationSetFailures` takes the set name, so each failure names the set it concerns and a broken partner set is never reported as an alert-set problem. The check never reads the identity's default set, which belongs to its owner. The alarm mailer is the one sender still without a set, so the check does not see it. The client is bound to the stack's region (`TARGET_REGION`), so it cannot see an identity or Cognito configuration set in a different `ses_region`. A test send (`--send-test`) is a live provider write and runs only behind its own confirmations. The provider reads used by this check are implemented in `infra/src/ops/ses-common.ts` (`createAwsSesOperationsApi`, `getConfigurationSet`). The procedure lives in the [email setup runbook](../../docs/runbooks/email-setup.md).

### How the stack gates it

The stack's three parameters default to `UNCONFIGURED`, the same sentinel convention as the SMS inputs ([configuration and readiness](configuration-and-readiness.md)). Validation rules, not the runtime, enforce the combinations:

```mermaid
flowchart TD
  P["PartnerUserPoolId, ClientId, ClientSecretArn"] --> A{"all three UNCONFIGURED or all three supplied?"}
  A -- "no (partial)" --> R1["Rule PartnerUserPoolSelectionIsComplete refuses deploy"]
  A -- "yes, all supplied" --> B{"ProvisionApplication = true?"}
  B -- "no" --> R2["Rule PartnerUserPoolRequiresLiveApplication refuses deploy"]
  B -- "yes" --> C["ShouldUsePartnerUserPool true: scoped IAM policy and env vars"]
  A -- "yes, all UNCONFIGURED" --> D["No partner grant, env carries UNCONFIGURED"]
```

Caption: partner access is on only when every identifier is supplied and a live App Runner application exists.

Runtime invariants the stack tests pin (`describe('partner user pool boundary')` in `infra/test/stack/psd-eoc-stack.test.ts`):

- The `PartnerUserPoolClientSecretArn` allowed pattern accepts only the `/psd-eoc/partner-user-pool-client` path with the six-character generated suffix. A name without that suffix can never match the read grant. The test `pins the secret path the Terraform root creates` reads `main.tf`, so renaming one side alone fails the suite.
- The Cognito grant names one pool through `PartnerUserPoolId`, with the actions `AdminCreateUser`, `AdminDisableUser`, `AdminInitiateAuth`, `AdminRespondToAuthChallenge`, `StartWebAuthnRegistration`, and `CompleteWebAuthnRegistration`. No delete and no wildcard pool.
- The client secret reaches the service only as an ARN reference, and no output republishes the pool, client, or secret ARN.

Current state, which matters for every change here:

- No server code reads `PSD_EOC_PARTNER_USER_POOL_*` (a search of `packages/` finds nothing). Partner sign-in is configuration only; the server-side path is tracked as issue #593. Today the only sign-in is Google OIDC for staff.
- The stateful root writes the client secret into a Secrets Manager version and therefore into Terraform state. This deliberately departs from the migration plan's rule that no secret version enters state; the stateful README records why (Cognito generates the secret, so Terraform reads it back regardless). The state bucket must therefore be treated as secret-bearing.
- The readiness status `configured-unverified` for partner sign-in is recorded only in [docs/INTEGRATIONS.md](../../docs/INTEGRATIONS.md). Nothing was applied to any account as of 2026-10-23.

Change navigation:

- Consult this section before changing a partner parameter pattern, the Cognito pool or client settings, the secret path, the pool's email path, or the stack's partner IAM policy. A change to the secret path must change `main.tf`, the stack's allowed pattern, and the stack test together.
- Renaming a `stack_parameters` key must also rename the matching `PartnerUserPool*` parameter in `infra/src/stack/psd-eoc-stack.ts`. The `partner_pool_plan` run asserts the exact key set, and the stack test pins the parameter side, so a one-sided rename fails one of them.
- Narrow checks: `bun run verify:terraform` (fmt, validate, mocked `terraform test` on `partner_user_pool.tftest.hcl`) and `bun test infra/test/stack/psd-eoc-stack.test.ts`. Run `bun run --cwd infra synth:example` for stack wiring. For email changes, the relevant runs in `partner_user_pool.tftest.hcl` are `partner_pool_plan` (its assertions pin `DEVELOPER`, the identity ARN, the From address and the service-linked role), `unverified_ses_identity_is_refused` (precondition failure on an unverified identity) and `from_address_outside_identity_is_refused` (validation failure on a From address outside the domain).
- Scope boundary: agents never run `apply`, `deploy`, or `import` against a real account (AGENTS.md §5). `cdk deploy` stays a human's local action. Terraform applies belong to the CI pipeline behind the `production` approval, not to agent or ad-hoc local runs, and `terraform init` against a real backend is human-run. The checked-in backend bucket is a deliberately unusable placeholder.
- Guard: `scripts/verify-documentation.test.ts` (`forbids workflows that deploy the CDK stack or its images`) fails if a workflow deploys CDK, CloudFormation, App Runner, or an image, and it fails if source documents restate the pre-standard "no GitHub deployment environment or OIDC role" rule.
- Documentation drift: the stateful README states the handoff as one contract with the stack, so keep [configuration and readiness](configuration-and-readiness.md) and this section consistent with it.

## Proposed Terraform migration (not started)

`docs/terraform-migration-plan.md` is a proposal, status "no phase has started", with every open question answered on 2026-10-23 and each phase awaiting product-owner approval. It would replace the `PsdEoc` CloudFormation stack (`infra/src/stack/psd-eoc-stack.ts`, `infra/src/monitoring.ts`) with AWS Terraform roots under `infra/terraform/`. Only the `stateful/` root exists, and it holds just the partner pool described [above](#partner-first-responder-directory-terraform-stateful-root); the `app/`, `scripts/`, and `state-bootstrap/` roots from the plan do not exist. The CDK code and the deploy model above remain the source of truth for everything else. Do not implement any phase from this page; read the plan itself first.

Key decisions the plan records:

- **Two roots, split by data risk:** `stateful/` (Aurora, KMS, S3, secret containers, SQS, SES config set, SMS resources, ECR, log groups, the responder Cognito pool and its Cognito configuration set) and `app/` (IAM, App Runner, ECS, Lambdas, EventBridge, alarms, dashboard, canary, Route 53). Every `stateful/` resource carries `prevent_destroy`; `app/` reads `stateful/` outputs and never the reverse.
- **Tenant values and switches leave CFN parameters:** switches become tfvars variables with no default, so a missing file fails the plan instead of turning channels off. `infra/cdk.local.json` stays the tenant file during the transition. CI reads values from the GitHub `production` environment, as the plan decided. The Terraform side of that is already the standard (CI-only apply behind `production`); the `PsdEoc` CDK stack keeps its local `cdk deploy` path until phase 5 ([working conventions](../quickstart.md#working-conventions)).
- **Secrets stay out of state:** no `aws_secretsmanager_secret_version`; Aurora `master_password` is `ignore_changes`. The partner stateful root is the one existing exception, documented [above](#partner-first-responder-directory-terraform-stateful-root).
- **Phase gates:** each phase has an exit condition, and the zero-change import plan (0 add, 0 change, 0 destroy) is the critical gate before the CloudFormation stack is deleted.

```mermaid
flowchart LR
  P1["1 Scaffolding and CI"] --> P2["2 Retain everything in CDK"]
  P2 --> P3["3 HCL and zero-change import plan"]
  P3 --> P4["4 Delete CFN stack and import state"]
  P4 --> P5["5 Deploys through Terraform"]
  P5 --> P6["6 Remove CDK and close standard gaps"]
```

Caption: phase order from the plan. Phase 4 is the irreversible step (after it, the path back is fix-forward in Terraform); phase 5 is when the stack's deploys move from local `cdk deploy` to Terraform applied through CI.

Change navigation for this proposal:

- Consult the plan's Phases and Risks sections before any infra change that might collide with migration (the plan asks to freeze CDK infrastructure changes between phase 2 and phase 4).
- Current validation: `bun run --cwd infra typecheck` and `bun run --cwd infra synth:example` for CDK, plus `bun run verify:terraform` (`terraform fmt -check`, `validate`, and mocked `terraform test` for each AWS root, run inside `bun run check`). `tflint` and the planned `terraform.yml` workflow do not exist yet.
- Related docs the plan says will need updates in phase 5: `docs/CONFIGURATION.md`, `infra/README.md`, the runbooks that name `cdk deploy`, and the readiness register ([configuration and readiness](configuration-and-readiness.md)).

## Change recipes

- **New AWS resource/parameter:** add in `psd-eoc-stack.ts`, add the parameter to the `docs-contract:cdk-context`/parameter lists in `docs/CONFIGURATION.md` (otherwise `bun run verify:docs` fails), extend `psd-eoc-stack.test.ts`, run `bun run --cwd infra synth:example`.
- **New worker/queue:** also add its scoped secret, alarms in `monitoring.ts` (with DLQ runbook) and the server internal route; follow [channel workers](../integrations/channel-workers.md).
- **Lambda change:** Lambdas are plain `.mjs` under `infra/lambda/*` with matching `infra/test/*-runtime.test.ts`; keep `index.d.mts` in step.
- **Partner pool or handoff change:** update `infra/terraform/stateful` and the matching `PartnerUserPool*` parameter pattern together, then run `bun run verify:terraform` and `bun test infra/test/stack/psd-eoc-stack.test.ts`; update [configuration and readiness](configuration-and-readiness.md) if a parameter or its meaning changes.
- **Partner email change (identity, From address, sending account, configuration set):** change `variables.tf` validations and `main.tf` `email_configuration` together, keep the mocked `partner_pool_plan` assertions in step, then run `bun run verify:terraform`. Do not relax the verified-identity `precondition`; it is the guard that keeps a plan from creating a pool that cannot send codes. The configuration set, topic, key and event destination live in `ses_region` through `provider = aws.ses`; a resource added without that provider lands in `aws_region`, where the identity may not exist. Never point the pool at `psd-eoc-transactional`.
- **Partner account mail set or event routing change:** `SES_PARTNER_*` in `infra/src/config.ts`, the `PartnerEmailConfigurationSet*`, `PartnerEmailEventsTopic` and `SendOnlyPartnerAccountEmail` wiring in `infra/src/stack/psd-eoc-stack.ts`, and `partnerEmailEventsTopic` in `infra/src/monitoring.ts`. Also check the runtime read in `resolvePartnerProviders` (`packages/server/lib/partners/providers.ts`), which must keep returning null without the set. Run `bun test infra/test/stack/psd-eoc-stack.test.ts` and `bun test packages/server/lib/partners/providers.test.ts`. A stack change that moves or renames the set also needs the matching `configurationSetFailures` scope reviewed in the readiness check below, because that check reads only `psd-eoc-transactional`.
- **SES readiness check change:** `infra/src/ops/ses-common.ts` (the AWS reads and the `SES_*` constants) and `infra/src/ops/ses-verification.ts` (the failure messages, the gates, and `CHECKED_CONFIGURATION_SET_NAMES`, which decides which sets are read). A newly named set must be added to that list and to the stack, or the check reads a set the stack does not create. Both `--check` and the test-send path share `readSourceReadiness`, so a new check reaches both. Run `bun test infra/test/ses-operations.test.ts`; its blocker tables (`sourceBlockers`, `configurationSetBlockers`) and the MAIL FROM tests pin each failure message.
- **Conditional:** `bun run --cwd infra typecheck` (includes synth) when touching stack code; never run `deploy`, `cdk deploy`, or Terraform apply from automation.
