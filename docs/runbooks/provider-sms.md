# Provider runbook: AWS End User Messaging SMS outage

Use this runbook for SMS queue backlog, provider rejection/throttling,
delivery-event gaps, opt-out failures, or an AWS/carrier incident.

Current provider and alarm state lives only in the
[operational readiness register](../INTEGRATIONS.md). Carrier registration and
number allocation never authorize sending; see
[sms-registration.md](sms-registration.md).

**Source-defined conditional monitoring alarms:**

- `psd-eoc-sms-worker-health` fires after two consecutive 20-minute periods
  without the enabled worker's sanitized heartbeat;
- `psd-eoc-sms-outbox-to-provider-p95` fires when completed SMS handoff p95
  reaches 15 seconds for two consecutive periods; and
- `psd-eoc-sms-worker-message-failures` fires when the worker reports a bounded
  work, receipt, or opt-out processing failure.

The filters and alarms are created only when the SMS worker is enabled. Their
source definitions do not prove they are deployed or authorize provider I/O.

## Safety posture

- Keep SMS dark while the channel is disabled. Do not enable it to diagnose
  or clear a queue.
- Never substitute a personal phone, unapproved vendor, console send, or
  manually copied recipient list.
- Never log phone numbers, opt-in/opt-out data, message bodies, registration
  input, or raw carrier/provider responses.
- Provider acceptance is not carrier delivery or human receipt. Ambiguous send
  outcomes stay `unknown` and are not retried.
- SMS copy must remain length-safe and explicitly distinguish real incidents
  from drills.
- `ProvisionAwsEumSmsResources` and `EnableAwsEumSmsWorker` are separate on
  purpose. Leave the retained provider resources provisioned when darkening the
  worker; do not force deletion of a carrier pool as an outage response.

## Channel-constraint migration

Migration `0032_woozy_stardust.sql` added `outbox_channel_plan_shape` as a
`NOT VALID` constraint. Migration
`0049_gut_delivery_tests_and_truth_labels.sql` rewrote every retained outbox
message to the current channel-plan shape and re-added the constraint
validated, so no manual validation step remains.

## Respond

1. Confirm the protected account/region, exact deployed worker/configuration
   revision, `ProvisionAwsEumSmsResources`, `EnableAwsEumSmsWorker`, whether the SMS
   channel is enabled, `psd-eoc-sms` work queue/DLQ state, and the separate
   `psd-eoc-sms-receipts` queue/DLQ state. The worker role can consume but
   cannot publish to the receipt queue; EventBridge is its only writer.
2. If routable staff work reached the provider boundary while SMS was
   disabled, classify **SEV-0**, preserve evidence, and follow
   [rollback.md](rollback.md). Do not send or replay it.
3. If SMS is enabled, inspect read-only AWS
   Health, registration/number status, CloudWatch metrics, and
   `/psd-eoc/workers/sms` reason codes for the UTC interval. Do not expose the
   phone number.
4. Separate policy/registration block, opt-out, pre-send validation failure,
   safe-to-retry provider rejection, terminal failure, provider acceptance,
   delivery proof, and ambiguous outcome.
5. Use [alarm-sqs-age.md](alarm-sqs-age.md) or
   [alarm-dlq-sms.md](alarm-dlq-sms.md). Check push and email
   independently; normal canonical delivery may continue through approved
   channels, but operators must not manually reroute.

## Recover and verify

- It is acceptable to leave SMS dark and document the gap in the readiness
  register.
  Do not weaken a provider policy or misclassify emergency-alert traffic to
  obtain approval.
- Any provider, registration, number, opt-out, credential, or worker change
  needs product-owner approval and an explicit rollback point.
- Confirm the adapter remains fail closed while the channel is disabled,
  initial and retry work older than the fixed five-minute total lifetime is
  discarded without provider I/O, and queue/DLQ state is stable.
- Do not send a production SMS to test recovery. A drill still needs verified
  credentials/registration, consented endpoints, and authenticated-human
  confirmation in the application.

### Recover the approved handset after the STOP proof

The production worker intentionally has no generic endpoint re-enable route.
Do not clear the append-only STOP fact or treat an unauthenticated START claim
as evidence. After the handset owner sends `START` or `UNSTOP`, a human operator
must verify in the protected AWS account that the exact number is absent from
the managed opt-out list. Then run the ordinary roster sync so the endpoint is carried by a new immutable
snapshot. If any of those facts cannot be verified, leave the endpoint
suppressed.

Record the go-live disposition in the readiness register: either SMS has
independently verified end-to-end evidence or it is explicitly dark with no
queued/provider path. Never describe registration success as delivery
readiness.
