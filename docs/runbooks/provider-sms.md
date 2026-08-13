# Provider runbook: AWS End User Messaging SMS outage

Use this runbook for SMS queue backlog, provider rejection/throttling,
delivery-event gaps, opt-out failures, or an AWS/carrier incident.

**Current truth:** SMS is `blocked` in `docs/INTEGRATIONS.md`. D-013 explicitly
allows go-live with push and email while SMS remains dark. Carrier registration
and number allocation do not authorize sending. See
[sms-registration.md](sms-registration.md).

**Source-defined monitoring alarms:**

- `psd-eoc-sms-outbox-to-provider-p95` fires when completed SMS handoff p95
  reaches 15 seconds; and
- `psd-eoc-sms-outbox-to-provider-incomplete` fires when at least one SMS
  endpoint has not reached provider acceptance by the deterministic one-minute
  cutoff.

Issue #29 source landed in pull request #96, but no approved deployment,
CloudWatch read-back, alarm-action exercise, or console deep link is recorded.
Treat both alarms as **live-unverified**. Their source definition does not
change the `blocked` SMS integration truth or authorize provider I/O.

## Safety posture

- Keep SMS dark while its truth label is `blocked` or
  `configured-unverified`. Do not enable it to diagnose or clear a queue.
- Never substitute a personal phone, unapproved vendor, console send, or
  manually copied recipient list.
- Never log phone numbers, opt-in/opt-out data, message bodies, registration
  input, or raw carrier/provider responses.
- Provider acceptance is not carrier delivery or human receipt. Ambiguous send
  outcomes stay `unknown` and are not retried.
- SMS copy must remain length-safe and explicitly distinguish real incidents
  from drills.

## Respond

1. Confirm account `<aws-account-id>`, region `us-west-2`, current fan-out control
   epoch, SMS truth label, and `psd-eoc-sms` queue/DLQ state.
2. If routable staff work reached the provider boundary while SMS was blocked
   or unverified, classify **SEV-0**, preserve evidence, and follow
   [emergency-disable.md](emergency-disable.md). Do not send or replay it.
3. If SMS was separately approved and `live-verified`, inspect read-only AWS
   Health, registration/number status, CloudWatch metrics, and
   `/psd-eoc/workers/sms` reason codes for the UTC interval. Do not expose the
   phone number.
4. Separate policy/registration block, opt-out, pre-send validation failure,
   safe-to-retry provider rejection, terminal failure, provider acceptance,
   delivery proof, and ambiguous outcome.
5. Use [alarm-sqs-age.md](alarm-sqs-age.md) or
   [alarm-dlq-sms.md](alarm-dlq-sms.md). Check push and email
   independently; normal canonical fan-out may continue through approved
   channels, but operators must not manually reroute.

## Recover and verify

- It is acceptable to leave SMS dark and document the launch gap under D-013.
  Do not weaken a provider policy or misclassify emergency-alert traffic to
  obtain approval.
- Any provider, registration, number, opt-out, credential, or worker change
  needs product-owner approval and an explicit rollback point.
- Confirm the adapter remains fail closed at every non-`live-verified` state,
  no old-epoch work can be released, and queue/DLQ state is stable.
- Do not send a production SMS to test recovery. A future approved synthetic
  test still needs verified credentials/registration, exact opt-in targets, a
  consequence preview, product-owner authorization, and authenticated-human
  confirmation.

Record D-013 disposition in the go-live checklist: either SMS has independently
verified end-to-end evidence or it is explicitly dark with no queued/provider
path. Never describe registration success as delivery readiness.
