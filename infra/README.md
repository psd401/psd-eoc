# PSD EOC infrastructure baseline

This directory defines the `PsdEoc` AWS CDK v2 stack for account
`338414773271` in `us-west-2`. It is an always-on, multi-AZ baseline for the
school-safety application. Merging this code does not deploy it: repository CI
only typechecks, tests, and synthesizes the CloudFormation template.

## Safety and integration truth

The synthesized baseline cannot send a notification. It creates durable queues
and defines retained DNS and SES resources, but repository CI does not deploy
them. It creates no queue consumers, provider-send permissions, subscriptions,
or schedules. The generated Google and Expo secrets are deliberately unusable
placeholders.

[`docs/INTEGRATIONS.md`](../docs/INTEGRATIONS.md) is the single source of truth
for integration labels. GuardDuty Malware Protection for S3 is
`configured-unverified`: the exact plan, prefix, tagging action, and service
role are configured in CloudFormation, but no resource was deployed and no
scan result or plan status was verified. Synthesized resources, generated
placeholders, identity definitions, and passing tests are never evidence of a
live integration.

Provider activation remains subject to the synthetic-target, consequence
preview, authorization, and human-confirmation rules in `AGENTS.md`. Any
future label change must land in the canonical register with the required
evidence and approval.

## What the stack contains

- Aurora Serverless v2 PostgreSQL 16 with a `0.5` ACU floor, one writer and one
  promotion-tier reader in separate Availability Zones, Data API, encrypted
  storage, retained backups, and deletion protection. No auto-pause setting is
  present.
- A versioned, KMS-encrypted media bucket with every public-access block,
  TLS-only access, retained data, and no lifecycle deletion. Browser uploads
  require the no-default `MediaUploadAllowedOrigin` HTTPS parameter. CORS
  permits only `PUT` from that exact origin with the `content-type` request
  header, exposes only `ETag` and `x-amz-checksum-sha256`, and caches preflight
  results for five minutes.
- A GuardDuty Malware Protection for S3 plan restricted to `quarantine/`, with
  scan-result tagging enabled. Its dedicated service role follows the AWS
  prerequisite policy: only the GuardDuty-managed EventBridge rule, bucket
  notification and ownership checks, the exact validation object,
  quarantine-scoped reads and tags, and KMS use through regional S3. App
  Runner can read the resulting quarantine scan tag but has no object-tag
  write authority. Bucket policy additionally denies every non-GuardDuty
  principal from mutating quarantine tags or reading quarantine bytes unless
  the current object carries the exact clean tag, so another broad role in the
  shared account cannot forge or bypass the scan result. App Runner's media
  data access is limited to `quarantine/` and `ready/` object reads/writes plus
  the exact KMS operations S3 requires.
- A central fan-out queue plus push, email, and SMS work queues. Every queue has
  an attached retained dead-letter queue and bounded receive attempts; each
  dead-letter queue accepts redrive only from its paired source queue.
- An App Runner service with at least two provisioned instances and automatic
  source deployments disabled. Its database environment matches the server's
  Data API contract.
- Separate retained database admin and application secrets. App Runner can
  read only the application secret and has no permission to obtain the admin
  credential. Generated placeholders for Google OAuth, an Expo access token,
  and the API credential salt contain no source-controlled credential value.
- Retained, non-expiring CloudWatch log groups and encrypted operations and
  critical-alarm topics. Alarms and alarm subscriptions belong to phase 5.
- A retained public Route 53 zone for `alerts.psd401.net`, automatically
  delegated by a retained NS record in the existing same-account
  `psd401.net` zone. The three Easy DKIM CNAMEs and custom MAIL FROM MX and SPF
  records are retained and created in the delegated zone by CloudFormation.
- A retained SES identity for `alerts.psd401.net` with 2048-bit Easy DKIM,
  fail-closed custom MAIL FROM behavior, and a default transactional
  configuration set. Its selected send, delivery, bounce, complaint, reject,
  rendering-failure, and delivery-delay events publish only to a dedicated,
  encrypted, retained SNS topic. The topic has no subscription, and neither
  App Runner nor any worker receives an SES send permission from this stack.
- A short-session GitHub OIDC role restricted to this repository's immutable
  owner/repository IDs, the `main` ref, and the exact future reusable workflow
  `.github/workflows/deploy-infrastructure.yml`. It can assume only the
  account's standard CDK bootstrap roles; it has no static access key.

The account-level GitHub OIDC provider is shared with PSD Maps and is imported
by ARN. Creating another provider for the same issuer in this stack would fail.
GitHub's live repository OIDC settings report the immutable default subject
prefix `repo:psd401@1902994/psd-eoc@1326178900`, which the deploy-role trust
matches exactly before appending the `main` ref context.

The public `psd401.net` hosted zone is also imported by its verified static ID,
`Z2B9XR5HEMTG1R`. The stack creates the `alerts.psd401.net` child zone and its
delegation record together, so this account layout requires no manual DNS
provider step. A hosted-zone replacement or account move requires a new
read-only inventory check and reviewed infrastructure change; never create a
parallel child zone by hand.

The deploy role also requires `job_workflow_ref` to equal
`psd401/psd-eoc/.github/workflows/deploy-infrastructure.yml@refs/heads/main`.
That reusable workflow does not exist in this issue, so the role remains
unassumable until a separately reviewed deployment issue creates it. Existing
OIDC-capable workflows, including the comment-triggered Claude workflow, do
not match this condition and cannot assume the deploy role.

The generated `/psd-eoc/database/application` secret is deliberately blocked
until an approved database bootstrap creates its `psd_eoc_application` LOGIN
and grants that LOGIN membership only in the migration-owned `psd_eoc_app`
role. Never substitute `/psd-eoc/database/admin` for the application secret.
Until that bootstrap is reviewed and completed, database-backed App Runner
requests must fail closed.

## App Runner health-check contract

The approved server image must listen on port `3000` and implement
side-effect-free, unauthenticated `GET /api/health`. It returns `200` only when
the process can serve traffic. The route must never start or change an event,
send a notification, issue an all-clear, or close an event. App Runner checks
this exact path every five seconds.

## Media upload and scan contract

`MediaUploadAllowedOrigin` is required at deployment and accepts one HTTPS
origin only, without a path, query, fragment, embedded credentials, or
wildcard. It must be the reviewed browser origin that receives PSD EOC's
presigned private upload URLs. Adding another origin or request header is a
reviewed infrastructure change, not a runtime fallback.

Only objects whose keys begin with `quarantine/` enter the GuardDuty plan.
Tagging is enabled so GuardDuty can set `GuardDutyMalwareScanStatus` on the
scanned object. The application must continue to fail closed unless the exact
object has `NO_THREATS_FOUND`; a synthesized plan, an active plan, a missing
tag, or any other result does not make media readable or journal-visible.
Bucket policy enforces that gate on quarantine object reads for every
principal except sessions issued from the dedicated GuardDuty role. It matches
the stable IAM role ARN through `aws:PrincipalArn` rather than guessing an
AWS-controlled session name, and reserves all quarantine tag mutations to that
role.

The plan depends explicitly on its IAM role because AWS validates the role
while creating the plan and recommends an IaC dependency for propagation. The
role also retains AWS's exact access to the root
`malware-protection-resource-validation-object`; that single validation key
does not expand the plan's `quarantine/` scan scope.

Sanitized objects under `ready/` are create-only. The application sends
`If-None-Match: *`, and the bucket policy denies any ready-object creation that
omits that condition. The policy also denies deleting ready objects or
versions, preventing a delete-marker-and-recreate path from breaking the
database checksum binding. A retry may read and accept an existing object only
when its bytes, checksum, content type, cache control, and server metadata all
match the intended immutable object exactly.

## Local verification

From the repository root:

```sh
bun install
bun run --cwd infra synth
bun run check
```

Synthesis uses committed account-specific Availability Zone context and
disables new lookups. After dependencies are installed, the synthesis step
needs neither AWS credentials nor AWS API or context lookups.

## Manual deployment (not authorization)

The following command is documentation only. Do not run it unless product
owner Kris Hagel explicitly approves the production infrastructure change and
its reviewed consequence preview. A deploy must also have all of the following:

- short-lived human AWS credentials targeting account `338414773271` and
  `us-west-2`;
- a current CDK bootstrap in that account and the shared GitHub OIDC provider;
- an approved PSD EOC server image in same-account ECR, pinned by immutable
  SHA-256 digest and verified to satisfy the health-check contract;
- the exact approved HTTPS browser origin for private media uploads;
- an approved one-time database bootstrap procedure to run after CloudFormation
  creates Aurora and `/psd-eoc/database/application`, but before any
  database-backed use; it must grant the new LOGIN only `psd_eoc_app`
  membership and confirm App Runner cannot read `/psd-eoc/database/admin`;
- a reviewed CloudFormation change set and explicit confirmation that no live
  provider send path or real recipient data is being introduced; and
- separate approval before creating the delegated DNS zone, SES identity,
  configuration set, or other live provider configuration.

After replacing the digest marker, an authorized human may run from the
repository root:

```sh
bun run --cwd infra deploy -- \
  --require-approval broadening \
  --parameters 'AppImageIdentifier=338414773271.dkr.ecr.us-west-2.amazonaws.com/psd-eoc-server@sha256:REPLACE_WITH_64_HEX_CHARACTERS' \
  --parameters 'MediaUploadAllowedOrigin=https://eoc.example.invalid'
```

Replace `https://eoc.example.invalid` with the reviewed PSD EOC HTTPS origin;
the example is deliberately non-routable.

After the stack completes, confirm the `AlertsHostedZoneId`,
`AlertsHostedZoneNameServers`, retained delegation, DKIM status, custom MAIL
FROM status, configuration set, and unsubscribed SES event topic against the
reviewed change set. The `SesDkimRecordName1..3` and
`SesDkimRecordValue1..3` outputs are evidence of the automatically published
records; they are not instructions for a manual DNS change. Complete the
separately approved database bootstrap before enabling database-backed use;
until then, those requests fail closed. Do not infer SES production access,
event consumption, GuardDuty plan health, a successful malware scan, or
delivery verification from stack completion. No deployment was performed for
this issue.
