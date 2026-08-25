# PSD EOC infrastructure baseline

This directory defines the `PsdEoc` AWS CDK v2 stack for account
`<aws-account-id>` in `us-west-2`. It is an always-on, multi-AZ baseline for the
school-safety application. Merging this code does not deploy it: repository CI
only typechecks, tests, and synthesizes the CloudFormation template.

## Safety and integration truth

The synthesized stack cannot send an application notification. It creates
durable queues and defines retained DNS and SES resources, but repository CI
does not deploy them. Its schedules are limited to a rollback-only TEST canary
and a SELECT-only metrics collector, plus a targetless monthly reminder. The
reminder has no invocation target. Neither role has queue, event-mutation,
critical-capability, or provider-send permission. Alarm subscriptions use
deployment parameters rather than repository recipient data. The generated
Google and Expo secrets are deliberately unusable placeholders.

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
  TLS-only access, immutable retained `ready/` data, and a `quarantine/`-only
  one-day lifecycle for current, noncurrent, and incomplete abandoned uploads.
  Browser uploads require the no-default `MediaUploadAllowedOrigin` HTTPS
  parameter. CORS permits only `PUT` from that exact origin with the
  `content-type` and `if-none-match` request headers, exposes only `ETag` and
  `x-amz-checksum-sha256`, and caches preflight results for five minutes.
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
- A delivery queue plus push, email, and SMS work queues. Every queue has
  an attached retained dead-letter queue and bounded receive attempts; each
  dead-letter queue accepts redrive only from its paired source queue.
- An App Runner service with at least two provisioned instances and automatic
  source deployments disabled. Its database environment matches the server's
  Data API contract.
- Separate retained database admin and application secrets. App Runner can
  read only the application secret and has no permission to obtain the admin
  credential. Generated placeholders for Google OAuth, an Expo access token,
  and the API credential salt contain no source-controlled credential value.
- A retained `/psd-eoc/database/monitoring` secret whose generated
  `psd_eoc_monitoring` LOGIN is blocked until an approved bootstrap grants
  exact SELECT-only access. The metrics collector has no access to the admin
  or application secrets and never commits a database transaction.
- Retained, non-expiring CloudWatch log groups; encrypted operations and
  critical-alarm topics; parameterized email/SMS subscriptions; one-minute
  alarms; a targetless monthly live-delivery-test due reminder; append-only
  report-derived failed/missed alarms; and the `psd-eoc-operations` dashboard.
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

Authenticated `POST /api/health` is a distinct rollback-canary surface. The
caller sends no body or query parameters. Server-owned configuration pins a
reviewed synthetic facility and drill-template event type, then runs canonical
activation preview, TEST start, lifecycle preview, all-clear, and close inside
one outer transaction that must roll back. Success means the canonical path
and rollback sentinel both passed; it never means provider delivery was tested.
The server requires the bearer to have exactly the configured facility scope
and exactly those five grants, installs transaction-local statement/lock/idle
limits, and records only a closed failure-stage code in retained logs.

## Monitoring and metric truth

The canary runs once per minute and publishes alarm data into the validated
EventBridge schedule minute, so a bounded retry cannot masquerade as a newer
run. Its failure alarm uses `FILL(canarySuccess, 0)` to turn every absent minute
into an explicit failure instead of letting CloudWatch satisfy the evaluation
with an older success. It requires two of two one-minute periods. The
conservative design budget is 120 seconds of alarm periods, up to 60 seconds for
evaluation, and the 30-second Lambda timeout: 210 seconds, leaving 90 seconds
inside the five-minute paging objective. EventBridge timing and SNS email/SMS
delivery are best-effort, not hard SLAs, so deployment remains blocked until a
controlled synthetic alarm proves the configured recipients.
The role reads only the imported agent-key secret and publishes metrics in
`PSD/EOC`; it cannot call the Data API, queues, SNS, or a provider. The key must
be facility-scoped to the configured synthetic facility and incapable of every
human-only action. Its secret must use the AWS-managed `aws/secretsmanager` key;
the role deliberately has no KMS decrypt grant for a customer-managed key.

The separate collector uses `/psd-eoc/database/monitoring`, starts an explicit
transaction, immediately executes `SET TRANSACTION READ ONLY`, runs only a
closed static SELECT allow-list, and unconditionally calls rollback before
publishing. Its role has no commit, queue, SNS, event, application-secret,
admin-secret, or provider permission. Event, outbox, and delivery queries
require staff population and kind incident or drill; TEST is excluded.

`ActivationAcceptLatencyP50Ms`, `P95Ms`, and `P99Ms` measure human confirmation
consumption time to the immutable activation-transition transaction commit
timestamp. PostgreSQL calculates exact percentiles over one deterministic
source minute of staff incident/drill activations; CloudWatch graphs those
one-minute metrics without combining periods. The matching sample count is
shown and a null commit timestamp fails the collector.

Outbox-to-provider metrics cohort staff incident/drill activation outboxes by
that same source minute, then use the earliest retained `provider-accepted`
evidence for each endpoint before the deterministic cutoff. Percentiles describe
completed handoffs only—not delivery or human receipt. Every channel also
publishes and alarms on `OutboxToProviderIncompleteCount`, so a missing batch,
attempt, or provider acceptance cannot disappear from the latency truth.

The delivery widget is a closed-boundary latest endpoint-attempt truth
distribution for staff incident/drill intents created during the preceding 24
hours. Delayed schedule retries reproduce the same snapshot because attempts
and evidence after the scheduled boundary are excluded. It does not mix intent
acceptance into endpoint outcomes or count superseded retries as separate
deliveries. Attempts without any evidence remain a separate
`DeliveryEvidenceGapCount`; they are never promoted to `unknown`.

The monthly live-delivery-test reminder uses `cron(0 17 1 * ? *)`, the first
day of every month at 17:00 UTC (09:00 Pacific Standard Time or 10:00 Pacific
Daylight Time). The EventBridge rule deliberately has no target. Its native
`AWS/Events` `TriggeredRules` metric drives an operations alarm, so the reminder
cannot invoke the application, the capability engine, a queue, or a provider.

The SELECT-only collector derives destination-free test health from immutable
`delivery_test_runs` and append-only `delivery_test_reports`. It counts distinct
runs whose chain head at the deterministic closed-minute boundary is a terminal
`failed` report generated in that minute; a later correction cannot erase that
already-observed failure. It publishes
`MonthlyLiveDeliveryTestMissed = 1` on every observation after an
`America/Los_Angeles` calendar month closes while that immediately preceding
month has no terminal `succeeded` report for a run started within it; `failed`
and `incomplete` never satisfy the monthly obligation. This makes the first
actual observation authoritative even when the exact boundary invocation is
delayed or a collector is newly deployed. CloudWatch alarm actions occur on the
transition into alarm, so the asserted metric does not create repeated reminder
authority. PostgreSQL computes the Pacific boundaries with `AT TIME ZONE
'America/Los_Angeles'`, including daylight saving transitions. The detector
derives the observation instant from the validated schedule time, while
closed-minute failure metrics remain stamped at their source-cohort time. The
metrics contain no run ID,
target-set digest, endpoint, recipient, or destination, and they do not claim
provider acceptance is human receipt. Missing collector output is monitoring
impairment handled by the collector alarm, not fabricated failed or missed
evidence.

`track_commit_timestamp` is a static startup parameter. An approved deployment
must verify it is active after the reviewed Aurora restart or failover; only
transactions committed after activation have timestamps. A missing or null
timestamp is monitoring impairment, never evidence of a fast activation.

Alarm email/SMS, canary credential ARN, synthetic facility UUID, and drill
event-type-version UUID are no-default deployment parameters. No endpoint,
credential, or real recipient data belongs in source control.

## Alarm response runbooks

Never use an alarm response to start, all-clear, close, or notify for a real
event. Any critical product action remains a fresh authenticated human decision.

### Runbook: App Runner errors and latency

Open `psd-eoc-operations`, compare 5xx with all-route average, then inspect retained
application logs and the latest approved deployment. Generic request latency is
not activation acceptance. Preserve evidence; never retry a user activation.

### Runbook: Activation accept latency

Confirm recent staff incident/drill closed-minute cohorts, compare p50/p95/p99,
and
correlate Aurora capacity, replica lag, 5xx, and queue age. The metric runs from
human confirmation consumption to immutable activation transaction commit. Never
replay activation. Missing commit timestamps mean monitoring is impaired.

### Runbook: Aurora failover readiness and capacity

Confirm writer/reader health, promotion state, Data API, ACU utilization,
EventBridge/Lambda bridge errors, and canary. Never automate failover. Escalate
before a reviewed manual failover or capacity change, and retain the event
timeline.

### Runbook: Queue age and dead-letter queues

Identify the source queue or retained DLQ, inspect worker logs and integration
truth, and preserve messages. Do not delete, redrive, or replay automatically;
use reviewed reconciliation so ambiguity cannot cause duplicate notification.

### Runbook: Stuck outbox

Inspect the oldest staff outbox row not published or terminally failed within
one minute without editing it.
Correlate dispatcher logs, queue age, and DLQs. Never update, fabricate evidence,
or manually dispatch; use canonical idempotent reconciliation after the prior
outcome is known.

### Runbook: Roster sync failure age

Inspect the latest immutable staff sync, sanitized failures, last complete
snapshot, and Google truth label. Failed or partial work must never replace the
last complete snapshot. Do not enable credentials or publish partial data.

### Runbook: Outbox to provider latency

Compare completed-handoff p50/p95/p99 and incomplete endpoint count with queue
age, DLQ depth, worker logs, and integration truth. Provider acceptance is not
receipt. Do not retry ambiguity until retained evidence establishes a safe
outcome.

### Runbook: Metrics collector

Inspect the retained collector log, the dedicated monitoring LOGIN, Data API,
static startup parameter state, and the shared closed-minute schedule boundary.
The collector publishes success only after all SELECTs, unconditional rollback,
and operational metric publication succeed. Do not grant write access, substitute
an application/admin secret, or reinterpret missing latency data as success.

### Runbook: Monthly live delivery test

Treat the due alarm as a reminder only: it is not authority to start a test and
has no execution target. Inspect the append-only run and report history and the
canonical integration labels; never automatically retry, replay, supersede, or
fabricate a report. A live run requires a fresh authenticated human decision
through the canonical start-event path, verified credentials, `live-verified`
integrations, the exact approved synthetic target set and consequence preview,
and fresh confirmation. Standing approval may establish configuration evidence
but never authorizes an individual run. Preserve the distinction between
provider acceptance, delivery, human receipt, and `unknown`. If the collector
is impaired, follow its runbook rather than declaring the month failed or
missed.

### Runbook: Shallow canary

Within five minutes, distinguish HTTP/authentication, canonical capability,
database, and rollback-sentinel failure using sanitized logs. Verify TEST,
drill-template, synthetic roster, and mocked integration. Disable the schedule
if any invariant is uncertain; never weaken rollback or enable provider sends.

## Media upload and scan contract

`MediaUploadAllowedOrigin` is required at deployment and accepts one HTTPS
origin only, without a path, query, fragment, embedded credentials, or
wildcard. It must be the reviewed browser origin that receives PSD EOC's
presigned private upload URLs. Adding another origin or request header is a
reviewed infrastructure change, not a runtime fallback.

Every quarantine PUT is signed with and must send `If-None-Match: *`. Bucket
policy denies a quarantine write that omits that create-only precondition, so
reusing either the original URL or an idempotent replay grant after the first
successful PUT fails S3's precondition instead of creating another object
version and another malware scan.

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

The bucket lifecycle is also restricted to `quarantine/`: current and
noncurrent raw versions expire after one day, and incomplete multipart uploads
are aborted after one day. Upload grants themselves expire after ten minutes,
so this is bounded reclamation for abandoned untrusted bytes, not an extension
of upload authority. No lifecycle rule targets immutable `ready/` media.

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

- short-lived human AWS credentials targeting account `<aws-account-id>` and
  `us-west-2`;
- a current CDK bootstrap in that account and the shared GitHub OIDC provider;
- an approved PSD EOC server image in same-account ECR, pinned by immutable
  SHA-256 digest and verified to satisfy the health-check contract;
- the exact approved HTTPS browser origin for private media uploads;
- an approved one-time database bootstrap procedure to run after CloudFormation
  creates Aurora and `/psd-eoc/database/application`, but before any
  database-backed use; it must grant the new LOGIN only `psd_eoc_app`
  membership and confirm App Runner cannot read `/psd-eoc/database/admin`;
- an approved bootstrap for `psd_eoc_monitoring` as a `NOINHERIT` LOGIN with
  `USAGE` on `public` and column-level SELECT only for the columns referenced by
  the static queries in `lambda/metrics-collector/index.mjs`, including an
  explicit column-level `SELECT (xmin)` grant on `event_transitions`,
  `SELECT (id, started_at)` on `delivery_test_runs`, and
  `SELECT (id, run_id, sequence, status, generated_at)` on
  `delivery_test_reports`. Do not
  grant whole-table SELECT on any table containing actor metadata, message
  content, or recipient/endpoint identifiers. Grant only the EXECUTE privilege
  needed for `pg_xact_commit_timestamp(xid)`; it receives no `psd_eoc_app`
  membership, write privilege, or default privilege;
- reviewed `EXPLAIN` plans and representative-load verification for every
  collector SELECT; the monitoring changes add no schema index, so deploy must
  remain blocked if any rolling-window, first-evidence, or monthly-report query
  cannot finish well inside the 30-second collector timeout and two-minute
  collector alarm window;
- a narrowly granted facility-scoped agent key stored only in the canary
  credential secret and reviewed synthetic facility/drill-version IDs; the key
  exposes no human-only capability ID and its secret uses the AWS-managed
  `aws/secretsmanager` key;
- confirmed email and SMS SNS subscriptions plus an approved alarm-path test
  that proves both operations recipients actually receive a synthetic alarm;
- verification that `track_commit_timestamp` is active after the reviewed
  Aurora restart/failover before treating activation percentiles as available;
- a reviewed CloudFormation change set and explicit confirmation that no live
  provider send path or real recipient data is being introduced; and
- separate approval before creating the delegated DNS zone, SES identity,
  configuration set, or other live provider configuration.

After replacing the digest marker, an authorized human may run from the
repository root:

```sh
bun run --cwd infra deploy -- \
  --require-approval broadening \
  --parameters 'AppImageIdentifier=<aws-account-id>.dkr.ecr.us-west-2.amazonaws.com/psd-eoc-server@sha256:REPLACE_WITH_64_HEX_CHARACTERS' \
  --parameters 'MediaUploadAllowedOrigin=https://eoc.example.invalid' \
  --parameters 'OperationsTeamAlarmEmail=REPLACE_WITH_APPROVED_ALARM_EMAIL' \
  --parameters 'OperationsTeamAlarmSmsNumber=REPLACE_WITH_APPROVED_E164_ALARM_TARGET' \
  --parameters 'MonitoringCanaryCredentialSecretArn=arn:aws:secretsmanager:us-west-2:<aws-account-id>:secret:REPLACE' \
  --parameters 'MonitoringCanaryFacilityId=REPLACE_WITH_SYNTHETIC_UUID' \
  --parameters 'MonitoringCanaryEventTypeVersionId=REPLACE_WITH_DRILL_VERSION_UUID'
```

Replace every `REPLACE_...` marker from approved, owner-private deployment
inputs. Replace `https://eoc.example.invalid` with the reviewed PSD EOC HTTPS
origin; the example is deliberately non-routable.

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
