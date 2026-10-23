# AWS CDK to Terraform migration plan

**Status:** proposal, not approved. No infrastructure change or deploy is part
of this document. Every phase below needs the product owner's approval before
it starts.

**Why:** psd-dev-standards
[08-iac](https://github.com/psd401/psd-dev-standards/blob/main/standards/08-iac.md)
v0.2 makes Terraform the only infrastructure tool on AWS and lists psd-eoc as a
transitional CDK repository. The product owner decided on 2026-10-23 to move
all of psd-eoc to Terraform. A Cognito user pool for non-district first
responders is being written in Terraform from the start; this plan leaves a
place for it.

**Scope:** the one CloudFormation stack `PsdEoc` produced by
`infra/src/stack/psd-eoc-stack.ts` and `infra/src/monitoring.ts`. The Google
Cloud roots under `infra/gcp` are already Terraform and only get version
alignment.

## Evidence used

- The example-tenant synthesis (`infra/bin/synthesize-example.ts`), dumped to
  JSON on 2026-10-23 from commit `637f6980`. It renders every conditional
  resource, so it is a superset of what is deployed. The live stack's resource
  list must be read with `aws cloudformation list-stack-resources` before
  phase 3; that read was not done for this plan.
- psd-dev-standards 08 (v0.2), 12 (v0.2) and 13 (v0.2), all marked "not
  approved".
- `infra/gcp/*` Terraform roots and `docs/CONFIGURATION.md`.

## Inventory

The template has **270 resources** of 57 types, **25 parameters**, 9
conditions and 68 outputs. "Retain today" means the synthesized
`DeletionPolicy` is `Retain` or `RetainExceptOnCreate`. Bracketed conditions
mean the resource exists only when that condition is true.

### Stateful resources

Losing or replacing any of these loses data, history, an identity, or an
external registration.

| Resource                                                          | CFN type                                     | Count | Retain today | Notes                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------- | ----: | ------------ | ----------------------------------------------------------------------------------------------------- |
| Aurora cluster `psd-eoc`                                          | `RDS::DBCluster`                             |     1 | yes          | Serverless v2 0.5–1 ACU, deletion protection on, 14-day backups, master password via secret reference |
| Aurora writer                                                     | `RDS::DBInstance`                            |     1 | yes          | `db.serverless`, fixed AZ                                                                             |
| DB subnet group                                                   | `RDS::DBSubnetGroup`                         |     1 | yes          |                                                                                                       |
| DB cluster parameter group                                        | `RDS::DBClusterParameterGroup`               |     1 | **no**       | Replacement forces a cluster parameter change                                                         |
| Media bucket                                                      | `S3::Bucket` + `S3::BucketPolicy`            |   1+1 | yes / no     | Versioned, CORS, [ShouldProvisionApplication]                                                         |
| Reachability artifacts bucket                                     | `S3::Bucket` + `S3::BucketPolicy`            |   1+1 | yes / no     | 30-day expiry, [ShouldProvisionApplication]                                                           |
| KMS keys (operations, email events)                               | `KMS::Key`                                   |     2 | yes          | Encrypt SQS/SNS; deleting a key makes its data unreadable                                             |
| Secrets `/psd-eoc/*`                                              | `SecretsManager::Secret`                     |    15 | yes          | Fixed names; values must never enter Terraform state                                                  |
| Admin secret attachment                                           | `SecretsManager::SecretTargetAttachment`     |     1 | no           | No Terraform resource; drop (see phase 4)                                                             |
| Queues and DLQs `psd-eoc-*`                                       | `SQS::Queue`                                 |    13 | yes          | 6 work queues + 6 DLQs + health; DLQs hold evidence of failed sends                                   |
| ECR repository `psd-eoc/server`                                   | `ECR::Repository`                            |     1 | yes          | Immutable tags, keep-10 lifecycle                                                                     |
| Log groups `/psd-eoc/*`                                           | `Logs::LogGroup`                             |     9 | 8 of 9       | `FailoverMetricLogGroup` has no retention set and is not retained                                     |
| SES configuration set `psd-eoc-transactional` + event destination | `SES::ConfigurationSet`, `…EventDestination` |   1+1 | yes / no     | The SES identity itself is not in the stack (`infra/src/ops`)                                         |
| Email events topic                                                | `SNS::Topic`                                 |     1 | yes          | SES → SNS → SQS callback path                                                                         |
| SMS opt-out list, pool, protect config, configuration set         | `SMSVOICE::*`                                |     4 | yes          | [ShouldProvisionAwsEumSmsResources]; the opt-out list is legal record of STOP requests                |
| VPC, subnets, route tables, IGW, NAT, EIP                         | `EC2::*`                                     |    27 | **no**       | Not data, but Aurora's ENIs live here; replacing the VPC means replacing the database                 |
| Route 53 record                                                   | `Route53::RecordSet`                         |     1 | no           | Production hostname, [ShouldProvisionApplication]                                                     |
| App Runner service `psd-eoc`                                      | `AppRunner::Service`                         |     1 | **no**       | Service URL is the DNS target; replacement changes it and drops custom-domain links                   |

### Stateless resources

| Resource                                     | CFN type                                                |   Count | Notes                                                                            |
| -------------------------------------------- | ------------------------------------------------------- | ------: | -------------------------------------------------------------------------------- |
| IAM roles and inline policies                | `IAM::Role`, `IAM::Policy`                              |   29+28 | CDK-generated names; import keeps them                                           |
| Security groups and rules                    | `EC2::SecurityGroup`, `…Ingress`, `…Egress`             |   6+2+2 | DB security group belongs with the stateful root                                 |
| App Runner VPC connector, autoscaling config | `AppRunner::VpcConnector`, `…AutoScalingConfiguration`  |     1+1 |                                                                                  |
| ECS cluster, task definitions, services      | `ECS::Cluster`, `…TaskDefinition`, `…Service`           |   1+6+4 | Bootstrap, access sync, Expo push, SMS, email, email-callback                    |
| Lambda functions (kept)                      | `Lambda::Function`                                      |       3 | Delivery router, alarm mailer, Aurora failover metric                            |
| Lambda event source mapping, permissions     | `Lambda::EventSourceMapping`, `…Permission`             |     1+4 |                                                                                  |
| EventBridge rules                            | `Events::Rule`                                          |       4 | SMS delivery events, SMS opt-out schedule, access sync schedule, Aurora failover |
| SNS alarm topics, policies, subscriptions    | `SNS::Topic`, `…TopicPolicy`, `…Subscription`           |   3+4+6 | Two SMS subscriptions carry the on-call number                                   |
| SQS queue policies                           | `SQS::QueuePolicy`                                      |      13 |                                                                                  |
| CloudWatch alarms, metric filters, dashboard | `CloudWatch::Alarm`, `Logs::MetricFilter`, `…Dashboard` | 34+17+1 |                                                                                  |
| Synthetics canary                            | `Synthetics::Canary`                                    |       1 | [ShouldProvisionApplication]                                                     |
| GuardDuty malware protection plan            | `GuardDuty::MalwareProtectionPlan`                      |       1 | [ShouldScanMedia]                                                                |

### CDK helpers that are not migrated

08-iac says to drop CDK helpers instead of importing them. Their `Delete`
handlers are no-ops (`infra/lambda/bootstrap-deployment/index.mjs` returns
success on `RequestType === 'Delete'`; `AwsCustomResource` has no `onDelete`),
so removing them with the stack has no side effect.

| Helper                                                                                                | Replaced by                                               |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `Custom::AWS` image-digest lookup + its Lambda                                                        | The deploy script resolves the digest after `docker push` |
| `Custom::PsdEocBootstrapDeployment`, start/check Lambdas, 3 provider-framework Lambdas, state machine | Bootstrap gate in Terraform (phase 5)                     |
| `Custom::PsdEocRollbackImageValidation` + handler + provider Lambda                                   | Variable validation on the image digest                   |
| `Custom::PsdEocRollbackQuiescence`                                                                    | `precondition` reading the send services' desired counts  |
| `DockerImageAsset` (lives in the shared CDK bootstrap ECR repository)                                 | Image built and pushed to `psd-eoc/server`                |
| `BootstrapVersion` parameter, CDK asset bucket objects for Lambda code                                | `archive_file` from `infra/lambda/*`                      |
| Roles, policies and log group used only by these helpers                                              | Deleted with the stack                                    |

## Target layout

```text
infra/
  terraform/            # AWS Terraform (product owner decision, 2026-10-23)
    modules/            # only if the PSD module library is not ready
    stateful/           # one state: network, Aurora, KMS, S3, secrets (containers only),
                        #   SQS, SES config set, SMS resources, ECR, log groups,
                        #   responder Cognito pool
    app/                # one state: IAM, security groups (except DB), App Runner,
                        #   ECS, Lambdas, EventBridge, alarm topics, alarms, dashboard,
                        #   canary, Route 53 record, GuardDuty plan
    scripts/            # bun wrappers: tenant tfvars, image build, bootstrap gate
  gcp/                  # unchanged roots: main, bootstrap, firebase
```

- Two roots meet 08's "separate stateful and stateless" rule and 12's
  `prevent_destroy` rule: every resource in `stateful/` has
  `lifecycle { prevent_destroy = true }`.
- `app/` reads `stateful/` outputs through `terraform_remote_state`. Nothing in
  `stateful/` reads `app/`.
- **First-responder Cognito pool:** a user pool is stateful (users, passkeys).
  It is the first resource in `infra/terraform/` and goes in `stateful/`. It
  ships before this migration finishes, so it creates the `stateful/` root
  with the backend, providers, `default_tags` and the pool only; the state
  bucket (open question 1) must exist before its first apply. Its pool ID
  and client ID reach App Runner as new CloudFormation parameters until phase
  5, then as `terraform_remote_state` outputs. The migrated resources are later
  imported into the same root, so nothing about the Cognito work is redone.
- Providers: `required_version = "~> 1.16.0"`, `hashicorp/aws ~> 6.68`, and
  `hashicorp/awscc` only for `SMSVOICE::*` if hashicorp/aws v6 lacks them (to
  verify at implementation; not checked for this plan). `.terraform.lock.hcl`
  committed.
- Tags via provider `default_tags` only: `psd:application=psd-eoc`,
  `psd:environment`, `psd:owner`, `psd:managed-by=terraform`, `psd:repo`,
  `psd:data-classification`. Region is the tenant's `psdEoc:awsRegion`; the
  current deployment already uses the standard-13 default region.

## State backend

- One S3 backend per account and environment, `use_lockfile = true`, bucket
  versioning on, KMS encryption, public access blocked (08 State rules).
- Keys: `psd-eoc/terraform/stateful.tfstate` and `psd-eoc/terraform/app.tfstate`.
- Follow the `infra/gcp` pattern: the checked-in backend names a deliberately
  unusable bucket, and the wrapper passes the real one with
  `-backend-config=bucket=<value>` from the local tenant file.
- The state bucket is created outside these roots. 13-aws-accounts phase 1 puts
  one state bucket per account in the org-infrastructure repository; if that
  is not ready, a tiny `infra/terraform/state-bootstrap` root with local state
  (as `infra/gcp/bootstrap` does) creates it. Open question 1.
- State will contain secret-adjacent values (the review sign-in digest and the
  on-call SMS number in plain text, the Aurora endpoint). It never contains
  secret values: no `aws_secretsmanager_secret_version`, and Aurora's
  `master_password` stays unset with `ignore_changes`.

## Parameters to variables

CloudFormation keeps a parameter's last value between deploys. Terraform does
not, so every switch lives in a git-ignored tfvars file and **has no default**.
A missing file then fails the plan instead of silently turning every channel
off.

| CFN parameter                                                                                | Terraform variable                                                                          | Type / validation                                                                                            | Source file                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `ProvisionApplication`                                                                       | `provision_application`                                                                     | `bool`; drives `count` on conditional resources                                                              | `deploy.auto.tfvars` (ignored)                 |
| `EnableExpoPushWorker`, `EnableDirectPush`, `EnableEmailWorker`, `EnableAwsEumSmsWorker`     | `enable_expo_push_worker`, `enable_direct_push`, `enable_email_worker`, `enable_sms_worker` | `bool`, no default                                                                                           | `deploy.auto.tfvars`                           |
| `ProvisionAwsEumSmsResources`                                                                | `provision_sms_resources`                                                                   | `bool`                                                                                                       | `deploy.auto.tfvars`                           |
| `EnableMediaMalwareScanning`                                                                 | `enable_media_malware_scanning`                                                             | `bool`                                                                                                       | `deploy.auto.tfvars`                           |
| `PushProviderCutover`                                                                        | `push_provider_cutover`                                                                     | `object({ version = number, ios = string, android = string })`                                               | `deploy.auto.tfvars`                           |
| `SmsOriginationIdentityArn`, `SmsHelpMessage`, `SmsStopMessage`, `SmsDestinationCountryCode` | `sms_*`                                                                                     | `string`, same regex checks as today                                                                         | `deploy.auto.tfvars`                           |
| `RuntimeDatabaseIdleTimeoutSeconds`                                                          | `runtime_database_idle_timeout_seconds`                                                     | `number`                                                                                                     | `deploy.auto.tfvars`                           |
| `GoogleOauthSecretArn`, `GoogleGroupsSecretArn`                                              | `google_oauth_secret_arn`, `google_groups_secret_arn`                                       | `string`, ARN regex                                                                                          | `deploy.auto.tfvars`                           |
| `InitialAccessGroupId`, `…Email`, `…Name`, `InitialMobileTransitionEmailSha256`              | `initial_access_group_*`, `initial_mobile_transition_email_sha256`                          | `string`                                                                                                     | `deploy.auto.tfvars`                           |
| `AppReviewSignInSha256`                                                                      | `app_review_sign_in_sha256`                                                                 | `string`, `sensitive = true`, `disabled` or 64 hex                                                           | `deploy.auto.tfvars`                           |
| `OperationsTeamAlarmEmail`, `OperationsTeamAlarmSmsNumber`                                   | `operations_alarm_email`, `operations_alarm_sms_number`                                     | `string`, sms `sensitive = true`                                                                             | `deploy.auto.tfvars`                           |
| `RollbackApplicationImageDigest`, `RollbackApplicationRepository`                            | `application_image_digest`                                                                  | `string`, `^sha256:[0-9a-f]{64}$`; always supplied by the deploy script; a rollback supplies an older digest | command line                                   |
| `BootstrapVersion`                                                                           | dropped                                                                                     |                                                                                                              |                                                |
| CDK context keys in `cdk.local.json`                                                         | `tenant_*` variables                                                                        | typed, no defaults                                                                                           | `tenant.auto.tfvars.json` (ignored), generated |

- **Tenant values stay out of git.** `cdk.local.json` remains the single
  tenant file during the transition, because `infra/gcp/scripts/tenant.ts` and
  `scripts/ops` already read it. A bun wrapper generates
  `tenant.auto.tfvars.json` from it on every run; `.gitignore` gains
  `infra/terraform/**/*.auto.tfvars*` and `*.tfvars` with `!*.tfvars.example`
  exceptions. Renaming the file (for example `tenant.local.json`) is a later,
  separate change.
- `cdk.json`'s committed threats and synthetic groups move to a committed
  `infra/terraform/app/catalog.auto.tfvars.json` (or stay read from `cdk.json` by the
  wrapper until CDK is removed).
- `deploy.auto.tfvars.example` lists every switch with its safe value.
- The `docs-contract:template-parameters` list checked by
  `bun run verify:docs` becomes a `docs-contract:terraform-variables` list
  checked against `variables.tf`.

## Phases

### Phase 0 — decisions and rehearsal account

- Answer the open questions below.
- Choose where to rehearse. Recommendation: deploy the CDK stack with the
  example tenant into a non-production account and run phases 2–5 there
  end to end before production. 13-aws-accounts plans `psd-nonprod`; it does
  not exist yet.
- Exit: written answers; rehearsal account chosen.

### Phase 1 — Terraform scaffolding (no AWS writes)

- Create `infra/terraform/{stateful,app,scripts}` with providers, backend stub,
  typed and described variables, and the tenant wrapper.
- CI: `terraform fmt -check`, `validate`, `tflint`, and `terraform test` with
  mocked providers (the `infra/gcp/firebase` pattern), run from
  `bun run check`. Checkov and conftest when the shared `iac-checks` workflow
  exists.
- Align `infra/gcp` `required_version` and CI's Terraform 1.9.8 to 1.16 in the
  same phase, as a separate PR.
- Exit: `bun run check` passes; no cloud credential used.

### Phase 2 — Retain everything in CDK

- Add a CDK Aspect that sets `DeletionPolicy` and `UpdateReplacePolicy` to
  `Retain` on every `CfnResource` except the helpers listed above.
  Today 51 resources are retained; this adds the VPC and networking, App
  Runner, ECS, IAM, alarms, topics, policies, the parameter group, the bucket
  policies and the rest.
- Add a synthesis test: every non-helper resource has `Retain`. The existing
  logical-ID pin tests stay.
- Turn on stack termination protection (`terminationProtection: false` today in
  `infra/bin/psd-eoc.ts`).
- Deploy with unchanged parameters (`UsePreviousValue`). This is a normal
  deploy: the source revision changes, so the image rebuilds and the bootstrap
  task re-runs migrations. `cdk diff` must show only policy changes plus the
  usual image/revision update and **no replacement**.
- Verify with `aws cloudformation get-template` that the live template carries
  `Retain` on every kept resource.
- Rollback: revert the commit and deploy.

### Phase 3 — write HCL and prove a zero-change import plan

- Capture the live inventory: `list-stack-resources` (logical ID, physical ID,
  type) and `describe-stacks` parameter values. Store it outside the
  repository; it contains account identifiers.
- Write import blocks for every kept resource, generate config with
  `terraform plan -generate-config-out`, and rewrite it by hand into the two
  roots. Split CloudFormation resources that Terraform models separately:
  - S3: bucket, versioning, encryption, public access block, CORS, lifecycle,
    policy.
  - EventBridge: rule plus `aws_cloudwatch_event_target`.
  - ECR: repository plus lifecycle policy.
  - IAM: `AWS::IAM::Policy` → `aws_iam_role_policy` (`role:policy`).
- Leave `default_tags` off and add `ignore_changes` on Lambda and canary code
  for this step, so the first plan can show no changes.
- Run `terraform plan` read-only while CloudFormation still owns everything.
- Exit: both roots plan with **0 to add, 0 to change, 0 to destroy** and only
  imports. Any diff is fixed in HCL, not accepted.

### Phase 4 — retire the CloudFormation stack and import

Run in one maintenance window, with no deploy in between:

1. Re-run the phase 3 plan against current state; it must still be zero-change.
2. Turn off termination protection and delete the `PsdEoc` stack.
   CloudFormation deletes only the helpers and leaves every retained resource.
3. Check every physical ID from the phase 3 inventory still exists.
4. `terraform apply` the `stateful/` imports, then the `app/` imports. Imports
   are state-only.
5. Plan both roots again: zero changes.
6. Smoke-test: health URL, a drill on the review facility, alarms in `OK`.

Notes:

- 08 says "Aurora last". With one stack, the stack is deleted at once, so the
  order applies to the import applies. `stateful/` goes first because `app/`
  reads its outputs. Imports change no resource, and `prevent_destroy` plus
  the zero-change plan cover the replacement risk the rule guards against.
  This is a deviation that needs approval (open question 6).
- The `SecretTargetAttachment` only wrote host and port into the admin
  secret's JSON; the value stays. Rotation is not configured.
- Retained resources keep CloudFormation's `aws:cloudformation:*` tags.
  Terraform ignores `aws:` tags.
- Rollback: before step 2, stop. After step 2 there is no practical way back
  to CloudFormation (`cdk import` of ~240 resources); the path is fix-forward
  in Terraform. This is why phase 0 rehearses first.

### Phase 5 — deploys run through Terraform

- **Image:** the deploy script builds `packages/server/container/psd-eoc.Dockerfile`
  for `linux/amd64` with the same build args, pushes to `psd-eoc/server` by
  source SHA tag, and passes the resulting digest as
  `application_image_digest`. Images in the CDK asset repository stay there
  for rollback until the keep-10 history in `psd-eoc/server` replaces them.
- **Bootstrap gate:** a `terraform_data` resource triggered by the image
  digest runs a bun script that starts the bootstrap task, waits, and fails on
  a non-zero exit. App Runner, the four workers and the access-sync schedule
  `depends_on` it, so a failed migration stops the apply before promotion, as
  the custom resource does today. Alternative if provisioners are not allowed:
  the wrapper applies the bootstrap task definition, runs the task, then
  applies the rest.
- **Rollback quiescence:** a `precondition` on App Runner reads the send
  services with `data "aws_ecs_service"` and refuses an older digest unless
  every send switch is `false` and every send service is at zero.
- First Terraform deploy re-uses the running digest (no-op), then one real
  release.
- Add `psd:*` `default_tags` in its own PR. Check App Runner service and VPC
  connector tags update in place in the plan (in CloudFormation they force
  replacement, which is why the CDK code pins them).
- Remove `ignore_changes` on Lambda code; the next plan updates the functions
  in place from `archive_file`.
- Update `docs/CONFIGURATION.md`, `infra/README.md`, the runbooks that name
  `cdk deploy`, and the readiness register.

### Phase 6 — remove CDK and close standard gaps

- Delete `infra/src`, `infra/bin`, the CDK tests, `aws-cdk-lib`, `aws-cdk`,
  `cdk.json`, and the CloudFormation-specific docs contract. Keep
  `infra/lambda/*` sources and their runtime tests. Replace
  `synth:example` with a mocked `terraform test` that plans the example
  tenant, so portability stays proven without credentials.
- Do not delete the account's `CDKToolkit` bootstrap stack; other CDK apps may
  share it (open question 8).
- Gaps found against standards 08 and 12, each its own reviewed PR **after**
  the zero-change import, never folded into it:
  - Log retention is 14 days on 8 groups, unset on 1 (12 rule 5: prod 90).
  - Lambda functions and all six ECS task definitions are x86_64 (rule 9). The
    image build is `linux/amd64` today.
  - One NAT gateway and no S3 or DynamoDB gateway endpoint (rule 8).
  - Media bucket is versioned with no noncurrent-version expiration (rule 6).
  - Tags are `Application`, `Environment`, `ManagedBy=AWS CDK` and others,
    not `psd:*` (08 district defaults).
  - Weekly drift plan workflow (08 Drift).

## Risks

| Risk                                                                                | Mitigation                                                                                               |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A non-retained resource is deleted with the stack (App Runner, VPC, IAM) → outage   | Phase 2 retains all kept resources; synthesis test; `get-template` check before deletion                 |
| A Terraform property mismatch replaces Aurora, the VPC or App Runner on first apply | Zero-change plan gate; `prevent_destroy` in `stateful/`; App Runner in `app/` gets `prevent_destroy` too |
| Channel switches lost between applies turn notifications off                        | Switch variables have no default; missing tfvars fails the plan                                          |
| A provider lacks an `SMSVOICE` resource or import support                           | `awscc` fallback; verify in phase 1 before phase 2                                                       |
| Secret values land in state                                                         | No secret versions in Terraform; `ignore_changes` on Aurora password; state bucket access limited        |
| No automatic rollback after a failed apply                                          | Small applies; bootstrap gate before promotion; phase 4 rehearsed                                        |
| Window between stack deletion and import apply leaves resources unowned             | Single window, no deploys; inventory check                                                               |
| Synthetics canary import needs its code zip and may show an update                  | `ignore_changes` on code during import; build the zip from `infra/lambda/canary` afterwards              |
| SNS SMS subscriptions or confirmations behave differently on import                 | Import by ARN; verify `aws sns list-subscriptions-by-topic` before and after                             |
| Another session changes the CDK stack mid-migration                                 | Freeze CDK infrastructure changes from phase 2 to phase 4                                                |
| This plan was built from the example synthesis, not the live stack                  | Phase 3 starts from `list-stack-resources`                                                               |

## How this fits `infra/gcp`

- Same tool, separate states and backends: GCP stays on GCS, AWS uses S3.
- Same tenant pattern: variables without defaults fed from the git-ignored
  `cdk.local.json` by a wrapper, and a deliberately unusable checked-in
  backend bucket.
- Same test pattern: `terraform test` with mocked providers in CI.
- Cross-cloud links stay as values: the Google OAuth and Groups credentials are
  AWS secrets whose ARNs are variables. No root reads another cloud's state.
- `infra/gcp/scripts/run-guarded.sh` and `apply.ts` are the model for the AWS
  wrapper's caller and account checks (expected account alias, region).

## Open questions

1. State bucket: org-infra repo (13 phase 1) or a local `state-bootstrap` root
   here?
2. Who runs plan/import/apply on prod? 08 says CI with OIDC and environment
   approval, agents never locally; today Claude runs local `cdk deploy`.
3. Add a deploy workflow (08 PR flow) as part of this, or keep local deploys
   until 13 phase 1?
4. Rehearsal account: wait for `psd-nonprod`, or use a sandbox once with the
   example tenant?
5. `terraform_data` + local-exec bootstrap gate OK, or two-step wrapper?
6. Accept stateful-first import order (deviation from "Aurora last")?
7. Keep old tag keys (`Application`, `DataScope`, …) next to `psd:*`, or drop?
8. Other CDK apps in this account/region using `CDKToolkit`?
9. `psd:data-classification` value: `internal`, `student-pii`, or the
   `partner-pii` value requested for first responders?
10. The Cognito pool lands before phase 4. OK to add interim CFN
    parameters for its IDs?
11. Standards 08/12/13 are unapproved drafts; migrate to v0.2 as written?
12. Fold standard-12 gap fixes (arm64, 90-day logs, endpoints) into phase 6, or
    track separately?
13. Move `infra/gcp` under `infra/terraform/gcp` too, or keep it where it is?
