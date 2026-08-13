# Alarm runbook: SQS dead-letter queue depth

**Alarm IDs / CloudWatch deep links: BLOCKED BY #29.** Four planned DLQ alarms
cover the exact resources below. No alarm is deployed today.

Any DLQ message is retained evidence of work that could not complete safely.
It is not a redrive to-do list. Automatic or bulk replay is forbidden.

## Safety posture

- Do not press **Start DLQ redrive**, purge, receive, delete, or copy a message.
- Do not edit a body, reset receive counts, or send it to another queue.
- An ambiguous provider call remains `unknown`. Replaying it can duplicate a
  notification.
- Disabling fan-out terminally suppresses pending work. A later enable epoch
  must not release any message created in an older epoch.
- Raw payloads and provider responses are untrusted. Do not place them in
  tickets, screenshots, chat, or this repository.

## Common response

1. Confirm account `338414773271`, region `us-west-2`, exact DLQ name, paired
   source queue, and current emergency-disable epoch.
2. Classify the incident using the per-DLQ section below. Record oldest age,
   visible count, source-queue age/count, and first alarm time from CloudWatch.
3. Inspect the paired processor logs by UTC interval and sanitized batch or
   attempt ID. Count failure reason codes without opening bodies.
4. Establish whether the failure occurred before any provider call, after a
   proven terminal rejection, after a proven safe-to-retry rejection, or with
   an ambiguous outcome. If evidence does not prove one category, use
   `unknown`.
5. Stop growth by fixing or rolling back the proven cause. Do not treat redrive
   as containment.
6. Open one follow-up record for disposition. It must preserve original
   message/evidence IDs and document why each item is permanently suppressed,
   reconciled without a provider call, or eligible for an individually
   reviewed replay mechanism. No such production replay mechanism is verified
   in the current repository, so replay is **BLOCKED**.

### Central fan-out DLQ

- Queue: `psd-eoc-fanout-dlq`
- Source: `psd-eoc-fanout`
- Severity: **SEV-1**; batches for every channel can be affected.
- Check transactional outbox evidence, central router authorization, real/drill
  classification, roster snapshot ID, and current control epoch. Any mismatch
  is terminally suppressed and escalated; never reconstruct a batch locally.

### Push DLQ

- Queue: `psd-eoc-push-dlq`
- Source: `psd-eoc-push`
- Severity: **SEV-2**, rising to **SEV-1** for broad/only-channel impact.
- Continue with [provider-expo.md](provider-expo.md). Expo ticket acceptance is
  not delivery. Preserve invalid-device evidence without logging tokens.

### Email DLQ

- Queue: `psd-eoc-email-dlq`
- Source: `psd-eoc-email`
- Severity: **SEV-2**, rising to **SEV-1** for broad/only-channel impact.
- Continue with [provider-ses.md](provider-ses.md). A `MessageId` proves only
  provider acceptance; bounce, complaint, and delayed evidence stay
  append-only.

### SMS DLQ

- Queue: `psd-eoc-sms-dlq`
- Source: `psd-eoc-sms`
- SMS may ship dark under D-013 and is currently `blocked` in
  `docs/INTEGRATIONS.md`. Do not enable it to clear work.
- Any routable staff work that reached this queue while SMS was blocked or
  unverified is **SEV-0**. Preserve the control/integration evidence and follow
  [provider-sms.md](provider-sms.md).

## Recovery evidence

Record the root-cause issue, deployment/configuration digest, before/after
counts, every disposition category, all remaining `unknown` outcomes, and the
reviewing fan-out responder. A zero DLQ count is not by itself recovery proof;
the source queue, outbox, logs, delivery evidence, and alarm evaluation window
must agree. Never delete retained evidence merely to make a count zero.
