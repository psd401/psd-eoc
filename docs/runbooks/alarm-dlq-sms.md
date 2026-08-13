# Alarm runbook: SMS DLQ

**Alarm ID / CloudWatch deep link: BLOCKED BY #29.** The planned alarm targets
`psd-eoc-sms-dlq`, paired only with source queue `psd-eoc-sms`.

## Meaning and severity

SMS work could not complete safely after bounded attempts. SMS is currently
`blocked` and may remain dark at go-live under D-013. A dark queue with no work
is expected; routable staff work in the queue while blocked/unverified is
**SEV-0**.

## Respond

1. Do not receive, purge, delete, copy, edit, or redrive the message. Follow
   [alarm-sqs-dlq.md](alarm-sqs-dlq.md) for common disposition rules.
2. Confirm account/region, exact queue pair, emergency-disable epoch, oldest
   age, counts, channel-enable state, event-source state, provider permissions,
   and SMS integration truth without exposing a phone number.
3. If any routable staff work or provider call exists while the integration is
   not `live-verified`, emergency-disable fan-out and escalate **SEV-0**.
4. If SMS was independently approved/live-verified, review
   `/psd-eoc/workers/sms` by UTC interval, sanitized attempt ID, and bounded
   reason code. Separate policy/registration block, opt-out, pre-provider
   failure, terminal/safe-to-retry failure, provider acceptance, delivery proof,
   and ambiguous call.
5. Follow [provider-sms.md](provider-sms.md). It is acceptable to keep SMS dark;
   never enable it to clear the alarm or disguise emergency traffic to bypass
   provider policy.

## Verify

For the D-013 dark path, prove the channel remains off, no routable staff work
enters the queue, no event source/provider permission exists, and retained
unexpected work is terminally suppressed. For a separately live-verified path,
confirm new eligible work drains normally while old/ambiguous work is not
replayed. Provider acceptance is not delivery or human receipt.
