# Live-pilot email readiness evidence

Recorded: 2026-08-16 UTC

Change: issue #204

Truth label: **configured-unverified**
Activation state: **disabled**

This is a source/read-only-inventory record. It proves neither deployment nor
provider delivery. No AWS, SES, DNS, Expo, SMS, recipient, access, facility, or
neighborhood mutation occurred while preparing it. No provider message was
sent. No recipient address is recorded here.

## Read-only provider inventory

The inventory was taken in AWS account `338414773271`, alias `psd401`, region
`us-west-2`.

- SES account production access is enabled, account sending is enabled, and
  enforcement status is healthy. The observed quota was 50,000 messages per
  24 hours and 14 messages per second. This account-level capability is not PSD
  EOC send authorization.
- The existing `psd401.net` domain identity reports successful verification
  and DKIM. Issue #204 reuses it; it does not create or change an SES identity,
  hosted zone, record, DKIM token, or custom MAIL FROM domain.
- The only observed configuration set was `my-first-configuration-set`.
  Canonical PSD EOC configuration set `psd-eoc-transactional` was absent, so
  the source change creates it with `SendingEnabled=false`.
- The existing live-pilot App Runner role can read only its exact application,
  identity, OAuth/cookie, and API secrets plus health-queue attributes. It has
  no SES or queue-send action.
- No live-pilot email Lambda, ECS service, event-source mapping, or existing EOC
  email queue was observed.

The AWS End User Messaging SMS account reports `SANDBOX`, a USD 1 monthly
spend limit, no verified destination, no origination phone number, no pool, no
sender ID, no registration, and no protect configuration. SMS remains blocked.

The repository identifies Expo project
`24753a23-d863-41e6-8511-5e44c99fa6c2` owned by
`peninsula-school-district`. No repository/environment Expo token was found and
the local EAS CLI is unavailable. Credential custody, iOS/APNs and Android/FCM
provider setup, and physical-device evidence remain owned by issue #40. Push
remains blocked.

## Source readiness boundary

The retained live-pilot stack source defines:

- staff-minimized/live-pilot tags and retention for stateful data, generated
  secrets, ECR, queues, managed logs, the SES configuration set, SNS topic, and
  KMS key;
- Aurora deletion protection and 14-day backup retention;
- source queue `psd-eoc-email`, dead-letter queue `psd-eoc-email-dlq`, bounded
  five-receive redrive, managed encryption, TLS enforcement, and no producer;
- a dark worker role with only
  `sqs:ChangeMessageVisibility`, `sqs:DeleteMessage`,
  `sqs:GetQueueAttributes`, `sqs:GetQueueUrl`, and `sqs:ReceiveMessage` on the
  exact source queue;
- no `ses:*`, SNS, secret-read, pass-role, wildcard, or deployment permission
  for that worker and no executable service/event source that can assume it;
- canonical SES configuration set `psd-eoc-transactional` with reputation
  metrics enabled and sending disabled;
- retained encrypted topic `psd-eoc-email-events` for complete SES event types,
  with KMS and SNS policies scoped to the SES service, exact account, and exact
  configuration-set ARN;
- existing identity `psd401.net` and fixed sender
  `eoc-alerts@psd401.net`, without a DNS or identity resource;
- an App Runner truth sentinel of `UNVERIFIED`, with no provider credential;
  and
- a production composition seam that is dark by default. Its enabled form
  requires a durable attempt store, durable SES no-resend ledger, evidence
  writer, exact queue-invocation authorizer, delivery authorizer, live-provider
  authorizer, and final provider-send authorizer. Construction performs no
  network I/O.

Tests prove dark mode does not inspect provider work, an unverified invocation
fails before work, an incomplete enabled composition cannot construct, final
send denial releases the execution claim without touching SES or its ledger,
and a fully authorized synthetic DRILL fixture preserves the real/drill marker
while recording provider acceptance separately from receipt. The fully
authorized fixture is an in-memory contract test, not a deployed or live send.

## Explicit non-capabilities

Issue #204 does not add:

- a worker service, Lambda, event source, scheduler, SNS subscription, queue
  producer, or SES credential;
- `ses:SendEmail`, `ses:SendRawEmail`, or any provider-send permission;
- a recipient, recipient import, address in source/issues/artifacts, or use of
  the access roster as a notification list;
- an activation, real incident, notification, all-clear, event close, or
  offline deferred action;
- a workflow edit, deployment, provider call, configuration mutation, or test
  send; or
- student data or a weakening of server-side authorization, real/drill truth,
  append-only evidence, or human confirmation.

## Activation blockers and next change

Email activation is a separate issue and pull request after ownership is clear
for the protected workflow and the durable send/evidence path. That change must
provide and verify all of the following before it may request a controlled
test:

1. a production durable SES send ledger that prevents ambiguous resend;
2. durable execution/evidence stores and SES-event ingestion that preserve
   provider acceptance as distinct from human receipt;
3. an executable worker with exact queue-source authentication, least-privilege
   queue and `ses:SendEmail` authority, no broad identity or raw-email grant,
   and alarms/rollback;
4. protected preview/readback covering identity, configuration set, encrypted
   evidence destination, role policy, no broader provider authority, and zero
   existing sends attributable to the change;
5. one product-owner-selected staff target entered only at action time into
   authorized application data; and
6. an in-app consequence preview followed by fresh authenticated human
   confirmation immediately before exactly one unmistakable test message.

The selected target, provider acceptance, and human receipt must each be
recorded as separate facts. A successful SES API response proves only provider
acceptance.

Push cannot advance until issue #40 supplies district-held APNs/FCM/Expo
credentials and controlled physical-device evidence. SMS cannot advance until
the AWS account leaves sandbox and a reviewed origination identity,
registration, protection configuration, and approved target exist. Neither
blocker is bypassed by email readiness.

## Verification record

Before pull-request publication, the exact owned source set must pass:

- focused SES adapter/runtime and live-pilot stack synthesis tests;
- worker and infrastructure TypeScript checks plus CDK synthesis;
- formatting and lint for the owned file set; and
- a diff review proving zero SES permission, zero recipient data, and no file
  outside issue #204 ownership.

Results are appended to the pull request; a passing result does not change this
record to `live-verified`.
