# Alarm runbook: SQS oldest-message age

**Source-defined CloudWatch alarm names:**

- `psd-eoc-delivery-queue-age`;
- `psd-eoc-push-queue-age`;
- `psd-eoc-email-queue-age`; and
- `psd-eoc-sms-queue-age`.

Current deployment and alarm read-back state lives only in the
[operational readiness register](../INTEGRATIONS.md). Source-defined alarm
names are not deployment evidence.

## Meaning

Each source-defined alarm fires when its queue's oldest visible message stays
at or past 60 seconds for three consecutive one-minute periods; missing data is
non-breaching. It does not reveal whether a provider was called or a person
received anything.

Three periods rather than one, because a message that fails and returns to the
queue drives this metric as a sawtooth -- the age climbs while the message
waits and drops to zero the moment a worker takes it again. At one datapoint
the alarm followed every tooth, and a single undeliverable message produced
dozens of alarm-and-recovery notifications before the redrive policy retired
it. A queue that is genuinely not draining stays past the threshold across
consecutive minutes; a sawtooth does not.

A worker now retires a message whose failure states it cannot be retried,
copying it to the dead-letter queue and deleting it from the source instead of
leaving it to round-trip. The `*-dlq-depth` alarm is what fires in that case,
and it fires sooner than it used to.
PSD EOC queues are at-least-once boundaries; replay can duplicate provider
side effects unless the exact attempt is safely fenced.

## Safety posture

- Do not purge, redrive, receive, edit, copy, or manually send a message.
- Do not enable a worker, increase concurrency, change visibility timeout, or
  change a redrive policy without a reviewed production change and product-
  owner approval.
- Do not inspect message bodies in the console. They are untrusted and may
  contain operational event content. Use bounded metrics and sanitized IDs.

## Identify the affected stage

| Queue              | Stage                                             | Initial severity and next check                                                                                     |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `psd-eoc-delivery` | Central batch routing before channel queues       | **SEV-1** because all channels may be delayed; check stuck outbox and dispatcher/router runtime                     |
| `psd-eoc-push`     | Push worker before Expo provider boundary         | **SEV-2**, or **SEV-1** if push is the only available launch channel; use [provider-expo.md](provider-expo.md)      |
| `psd-eoc-email`    | Email worker before SES provider boundary         | **SEV-2**, or **SEV-1** with broader delivery impact; use [provider-ses.md](provider-ses.md)                        |
| `psd-eoc-sms`      | SMS worker before AWS End User Messaging boundary | Consult the readiness register; keep SMS dark while disabled, and treat unexpected routable staff work as **SEV-0** |

## Respond

1. Confirm the protected account/region and exact queue name.
   Record alarm start, current oldest age, visible count, in-flight count, and
   DLQ count from CloudWatch metrics.
2. Check the paired worker/router log group for startup, authorization,
   parsing, persistence, throttling, and provider reason codes. Use the UTC
   interval and sanitized batch/attempt IDs; do not copy raw payloads.
3. Check whether the paired DLQ depth is nonzero. If so, continue with the
   matching runbook: [delivery](alarm-dlq-delivery.md),
   [push](alarm-dlq-push.md), [email](alarm-dlq-email.md), or
   [SMS](alarm-dlq-sms.md).
4. For the delivery queue, also inspect outbox age and App Runner health. For a
   channel queue, inspect only that provider's status and adapter logs; a
   provider status page is not delivery evidence.
5. Determine whether work is being processed slowly, repeatedly failing, or
   not consumed. Treat source definitions separately from the deployed
   consumer evidence recorded in the readiness register.

## Recover and verify

- Fix or roll back the proven failing runtime/configuration. Use
  [rollback.md](rollback.md); do not work around the queue.
- Keep provider calls fail closed until the channel is enabled and the human
  activation action passes.
- Confirm oldest age and visible/in-flight counts decline through normal
  consumers, paired DLQ depth does not rise, and append-only attempt evidence
  remains truthful.
- Sample only sanitized attempt IDs through approved application evidence.
  Confirm retries use new attempts only after a proven safe-to-retry failure;
  ambiguous provider outcomes stay `unknown` and are not retried.
- Do not clear an alarm by purging or redriving. Do not send a live test. Any
  drill remains an authenticated-human action.

Close only after all four queue metrics have been reviewed for collateral
backlog, each exact alarm has a complete healthy evaluation period, and a
second responder reviews the evidence.
