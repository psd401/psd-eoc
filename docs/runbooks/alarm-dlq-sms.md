# Alarm runbook: SMS DLQ

**Source-defined CloudWatch alarm name:** `psd-eoc-sms-dlq-depth`, targeting
`psd-eoc-sms-dlq` paired only with source queue `psd-eoc-sms`.

Current deployment and alarm read-back state lives only in the
[operational readiness register](../INTEGRATIONS.md). A source-defined alarm
name is not deployment evidence.

## Meaning and severity

SMS work could not complete safely after bounded attempts. Consult the
readiness register before responding. A dark queue with no work is expected
when SMS is unavailable; routable staff work in the queue while the channel
is disabled is **SEV-0**.

## Respond

1. Do not receive, purge, delete, copy, edit, or redrive the message. Follow
   [alarm-sqs-dlq.md](alarm-sqs-dlq.md) for common disposition rules.
2. Confirm account/region, exact queue pair, oldest
   age, counts, channel-enable state, event-source state, and provider permissions
   without exposing a phone number.
3. If any routable staff work or provider call exists while the channel is
   disabled, stop the service and escalate **SEV-0**.
4. If SMS is enabled, review
   `/psd-eoc/workers/sms` by UTC interval, sanitized attempt ID, and bounded
   reason code. Separate policy/registration block, opt-out, pre-provider
   failure, terminal/safe-to-retry failure, provider acceptance, delivery proof,
   and ambiguous call.
5. Follow [provider-sms.md](provider-sms.md). It is acceptable to keep SMS dark;
   never enable it to clear the alarm or disguise emergency traffic to bypass
   provider policy.

## Verify

For a dark SMS path, prove the channel remains off, no routable staff work
enters the queue, no event source/provider permission exists, and retained
unexpected work is terminally suppressed. For an enabled
path, confirm new eligible work drains normally while old/ambiguous work is
not replayed. Provider acceptance is not delivery or human receipt.
