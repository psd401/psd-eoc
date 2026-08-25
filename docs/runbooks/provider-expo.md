# Provider runbook: Expo Push outage

Use this runbook when the push queue backs up, Expo requests fail, receipts are
delayed/unknown, or Expo reports an outage.

Current provider and alarm state lives only in the
[operational readiness register](../INTEGRATIONS.md). This runbook never
authorizes connecting or testing a provider.

**Source-defined monitoring alarms:**

- `psd-eoc-push-outbox-to-provider-p95` fires when completed push handoff p95
  reaches 5 seconds; and
- `psd-eoc-push-outbox-to-provider-incomplete` fires when at least one push
  endpoint has not reached provider acceptance by the deterministic one-minute
  cutoff.

The source definitions do not prove the alarms are deployed or authorize
provider I/O.

## Safety posture

- Never paste an Expo access token, device token, receipt payload, or recipient
  identity into logs, tickets, or this repository.
- Never bypass Expo by sending directly through APNs/FCM or another provider.
- A ticket/receipt means provider acceptance, not delivery or human receipt.
- An ambiguous network result stays `unknown`; do not blindly resend it.
- Push copy must retain exact `[INCIDENT]` versus `[DRILL]` classification.

## Respond

1. Confirm the environment, push integration
   truth label, and `psd-eoc-push` queue/DLQ state. If the label is not
   `live-verified`, provider I/O must remain disabled.
2. In CloudWatch, inspect `/psd-eoc/workers/push` by UTC interval, sanitized
   attempt ID, and bounded reason code. Do not inspect or copy destinations or
   raw Expo responses.
3. Check Expo's public status page and the authenticated Expo project read-
   only. Record the provider incident/time and project identifier without any
   token. A green status page does not disprove a PSD EOC configuration issue.
4. Separate pre-provider validation failures, safe-to-retry provider
   rejections, terminal invalid-device outcomes, provider-accepted tickets
   awaiting receipts, and ambiguous calls. Preserve those distinctions.
5. Check `psd-eoc-push` age and `psd-eoc-push-dlq` depth. Use
   [alarm-sqs-age.md](alarm-sqs-age.md) or
   [alarm-dlq-push.md](alarm-dlq-push.md) when needed.
6. Determine independently whether email is `live-verified` and healthy. The
   application may continue an already approved channel according to its
   canonical policy; operators must not manually copy recipients or message
   content to another channel.

## Recover and verify

- Restore the verified credential/runtime or roll back the proven regression
  using [rollback.md](rollback.md). Secret rotation follows
  [rotation-expo-token.md](rotation-expo-token.md) and needs product-owner
  approval before a live provider configuration change.
- Confirm queue age decreases through the canonical worker, DLQ depth does not
  increase, attempt evidence remains append-only, and receipts advance state
  only when they provide the required proof.
- Invalid-device evidence may deactivate that endpoint through the approved
  append-only path; never delete historical attempts or expose the token.
- Do not send a production test to prove recovery. Use an isolated synthetic
  non-production path. Any future live test is a fresh authenticated-human
  action under the readiness register and all AGENTS.md gates.

Escalate **SEV-1** when push is the only verified healthy launch channel,
multiple providers are impaired, classification integrity is uncertain, or
outcomes are broadly unknown. Record provider status separately from PSD EOC
observations.
