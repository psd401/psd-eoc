# Alarm runbook: SQS oldest-message age

**Alarm IDs / CloudWatch deep links: BLOCKED BY #29.** Four planned alarm
instances cover `psd-eoc-fanout`, `psd-eoc-push`, `psd-eoc-email`, and
`psd-eoc-sms`. None is deployed today.

## Meaning

An oldest-message-age alarm means work is not leaving a queue within its
planned time. It does not reveal whether a provider was called or a person
received anything. PSD EOC queues are at-least-once boundaries; replay can
duplicate provider side effects unless the exact attempt is safely fenced.

## Safety posture

- Do not purge, redrive, receive, edit, copy, or manually send a message.
- Do not enable a worker, increase concurrency, change visibility timeout, or
  change a redrive policy without a reviewed production change and product-
  owner approval.
- Do not inspect message bodies in the console. They are untrusted and may
  contain operational event content. Use bounded metrics and sanitized IDs.
- If the emergency-disable state is disabled or unreadable, queued work must
  remain suppressed. Re-enable must never release work from an earlier enable
  epoch.

## Identify the affected stage

| Queue            | Stage                                             | Initial severity and next check                                                                                                         |
| ---------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `psd-eoc-fanout` | Central batch routing before channel queues       | **SEV-1** because all channels may be delayed; check stuck outbox and dispatcher/router runtime                                         |
| `psd-eoc-push`   | Push worker before Expo provider boundary         | **SEV-2**, or **SEV-1** if push is the only available launch channel; use [provider-expo.md](provider-expo.md)                          |
| `psd-eoc-email`  | Email worker before SES provider boundary         | **SEV-2**, or **SEV-1** with broader fan-out impact; use [provider-ses.md](provider-ses.md)                                             |
| `psd-eoc-sms`    | SMS worker before AWS End User Messaging boundary | SMS is allowed to remain dark under D-013. Keep it dark while its integration is `blocked`; unexpected routable staff work is **SEV-0** |

## Respond

1. Confirm account `338414773271`, region `us-west-2`, and exact queue name.
   Record alarm start, current oldest age, visible count, in-flight count, and
   DLQ count from CloudWatch metrics.
2. Check the paired worker/router log group for startup, authorization,
   parsing, persistence, throttling, and provider reason codes. Use the UTC
   interval and sanitized batch/attempt IDs; do not copy raw payloads.
3. Confirm the current emergency-disable state and enable epoch from the
   authenticated application control view. If it cannot be read, treat it as
   disabled and escalate.
4. Check whether the paired DLQ depth is nonzero. If so, continue with the
   matching runbook: [central fan-out](alarm-dlq-fanout.md),
   [push](alarm-dlq-push.md), [email](alarm-dlq-email.md), or
   [SMS](alarm-dlq-sms.md).
5. For the fan-out queue, also inspect outbox age and App Runner health. For a
   channel queue, inspect only that provider's status and adapter logs; a
   provider status page is not delivery evidence.
6. Determine whether work is being processed slowly, repeatedly failing, or
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
backlog, the final #29 evaluation window is healthy, and a second responder
reviews the evidence.
