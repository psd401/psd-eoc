# Alarm runbook: Expo push worker health

**Conditional CloudWatch alarm names:**

- `psd-eoc-push-worker-health`; and
- `psd-eoc-push-receipt-poll-failures`.

Current deployment, credential, and provider truth lives only in the
[operational readiness register](../INTEGRATIONS.md). These alarms are created
only when the protected Expo worker is enabled. Their source definitions do
not prove deployment, provider access, notification delivery, or human receipt.

## Meaning and severity

The health alarm means an enabled worker did not emit its sanitized heartbeat
during the evaluation window. The receipt alarm means at least one bounded
receipt-poll cycle failed. Either can leave push work delayed or provider-
accepted outcomes unresolved. Treat as **SEV-2**, rising to **SEV-1** when push
is the only verified launch channel or staff notification work is broadly
delayed. Any real/drill ambiguity, unexpected provider call, or human-only
boundary bypass is **SEV-0**.

## Respond

1. Confirm the protected account/region, exact deployed image digest, worker
   desired/running task counts, alarm time, and whether the push channel is
   enabled. If it is disabled, preserve evidence and keep provider I/O dark.
2. Inspect `/psd-eoc/workers/push` only by UTC interval, sanitized attempt ID,
   and bounded event/reason code. Never copy a push token, recipient, raw queue
   body, provider response, or credential.
3. Compare ECS task stop reasons, push queue age/in-flight count, push DLQ
   depth, and the last `push-worker-heartbeat`. A running task alone does not
   prove polling or provider health.
4. For receipt failures, keep ticket acceptance, final receipt outcome,
   presentation, app tap, and human observation separate. A missing receipt is
   `unknown`; it is not delivery and does not authorize resend.
5. Identify the exact failure boundary: task startup/configuration, server
   capability authentication, queue polling, durable claim/state write,
   provider handoff, or receipt polling. Do not infer a provider outage from a
   missing heartbeat.

## Recover and verify

- Fix or roll back only the proven failure through direct `cdk deploy`.
  To stop the worker, first establish a quiescence fence and reconcile retained
  and in-flight attempts, then set `EnableExpoPushWorker=false`. Never purge,
  redrive, or replay queue items to clear the alarm.
- Confirm exactly one reviewed task becomes healthy, sanitized heartbeats
  resume, queue age declines through normal processing, DLQ depth does not
  rise, and append-only attempt/receipt evidence remains consistent.
- `DeviceNotRegistered` may invalidate only its exact endpoint fact. Confirm a
  later registration creates a new current fact; never restore or overwrite an
  invalidated endpoint.
- Do not send a notification to prove recovery. A physical drill is a fresh
  authenticated-human action in the running application after all readiness
  gates pass.

Record UTC times, image/configuration references, aggregate queue/task metrics,
sanitized immutable IDs, the exact repair or rollback, and second-responder
review. Append corrections; never rewrite earlier observations.
