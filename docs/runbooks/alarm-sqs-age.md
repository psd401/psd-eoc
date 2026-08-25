# Alarm runbook: SQS oldest-message age

**Source-defined CloudWatch alarm names:**

- `psd-eoc-delivery-queue-age`;
- `psd-eoc-push-queue-age`;
- `psd-eoc-email-queue-age`; and
- `psd-eoc-sms-queue-age`.

**Deployment/read-back truth:** issue #29 source landed in pull request #96,
but no approved deployment, CloudWatch read-back, alarm-action exercise, or
console deep link is recorded. Treat all four alarms as **live-unverified** and
their deep links as unavailable until #91 supplies that evidence.

## Meaning

Each source-defined alarm fires when its queue's oldest visible message reaches
60 seconds in one one-minute evaluation period; missing data is non-breaching.
It does not reveal whether a provider was called or a person received anything.
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

| Queue              | Stage                                             | Initial severity and next check                                                                                                         |
| ------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `psd-eoc-delivery` | Central batch routing before channel queues       | **SEV-1** because all channels may be delayed; check stuck outbox and dispatcher/router runtime                                         |
| `psd-eoc-push`     | Push worker before Expo provider boundary         | **SEV-2**, or **SEV-1** if push is the only available launch channel; use [provider-expo.md](provider-expo.md)                          |
| `psd-eoc-email`    | Email worker before SES provider boundary         | **SEV-2**, or **SEV-1** with broader delivery impact; use [provider-ses.md](provider-ses.md)                                            |
| `psd-eoc-sms`      | SMS worker before AWS End User Messaging boundary | SMS is allowed to remain dark under D-013. Keep it dark while its integration is `blocked`; unexpected routable staff work is **SEV-0** |

## Respond

1. Confirm account `338414773271`, region `us-west-2`, and exact queue name.
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
   not consumed. Because issue #91 has not deployed event-source/runtime
   wiring, the current repository cannot supply production consumer evidence.

## Recover and verify

- Fix or roll back the proven failing runtime/configuration. Use
  [rollback.md](rollback.md); do not work around the queue.
- Keep provider calls fail closed until the integration is `live-verified`,
  credentials and targets are verified, and the human live-action gates pass.
- Confirm oldest age and visible/in-flight counts decline through normal
  consumers, paired DLQ depth does not rise, and append-only attempt evidence
  remains truthful.
- Sample only sanitized attempt IDs through approved application evidence.
  Confirm retries use new attempts only after a proven safe-to-retry failure;
  ambiguous provider outcomes stay `unknown` and are not retried.
- Do not clear an alarm by purging or redriving. Do not send a live test. The
  monthly test in #30 remains human-confirmed and currently blocked.

Close only after all four queue metrics have been reviewed for collateral
backlog, each exact alarm has a complete healthy evaluation period, and a
second responder reviews the evidence.
