# Alarm runbook: push DLQ

**Alarm ID / CloudWatch deep link: BLOCKED BY #29.** The planned alarm targets
`psd-eoc-push-dlq`, paired only with source queue `psd-eoc-push`.

## Meaning and severity

Push work could not complete safely after bounded attempts. Classify **SEV-2**,
rising to **SEV-1** for broad impact, push as the only verified available
channel, or another channel outage. Safety-boundary failures are **SEV-0**.

## Respond

1. Do not receive, purge, delete, copy, edit, or redrive the message. Follow
   [alarm-sqs-dlq.md](alarm-sqs-dlq.md) for common disposition rules.
2. Confirm account/region, exact queue pair, emergency-disable epoch, oldest
   age, counts, and Expo integration truth. Non-`live-verified` truth must make
   zero provider calls.
3. Review `/psd-eoc/workers/push` by UTC interval, sanitized attempt ID, and
   bounded reason code. Never expose a device token or raw Expo response.
4. Separate pre-provider rejection, proven safe-to-retry failure, terminal
   invalid-device outcome, provider-accepted ticket/receipt lifecycle, and
   ambiguous provider call. Unknown work is never replayed.
5. Follow [provider-expo.md](provider-expo.md), fixing or rolling back the
   proven canonical worker/provider-boundary cause.

## Verify

Confirm new eligible work drains through the normal worker, old-epoch work
stays suppressed, DLQ growth stops, and immutable attempt/receipt evidence
advances only with proof. Provider acceptance is not delivery or receipt. Keep
each retained item blocked unless an individually reviewed mechanism can prove
zero duplicate provider side effect.
