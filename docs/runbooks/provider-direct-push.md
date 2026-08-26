# Provider runbook: direct APNs and FCM push

Use this runbook to activate, rotate, diagnose, or roll back direct APNs/FCM
delivery. Current provider truth lives only in the
[operational readiness register](../INTEGRATIONS.md). Source code, synthesis,
and synthetic tests do not authorize provider I/O.

## Stop conditions

Stop and preserve append-only evidence if a credential, token, recipient,
message body, or raw provider response appears in output; provider/environment
does not match the endpoint; one notification could be sent through two
providers; classification integrity is uncertain; or an ambiguous attempt is
queued for replay. Provider acceptance is not device delivery.

## Prepare in the dark

1. Keep `DIRECT_PUSH_ENABLED=false` and both platform cutovers on `expo`.
2. Confirm the exact dual-registration build is authorized separately for its
   Expo and native provider endpoints in the protected build allowlist.
3. Store the APNs token-signing identity and FCM service-account identity in
   their exact Secrets Manager records documented in
   [CONFIGURATION.md](../CONFIGURATION.md#direct-apnsfcm-activation-and-cutover).
   Never print or read back secret values. EAS-held signing credentials are not
   server push credentials.
4. Rotate each credential in isolation, retain a non-secret UTC evidence
   reference, and confirm the push task execution role is the only application
   role with read access. A configuration readback may show only secret
   ARN/version and structured `status`, never contents.
5. Reconcile the push queue and ambiguous attempt set by sanitized immutable
   IDs. Do not purge, redrive, or replay work.
6. Run provider-free contract, PostgreSQL lifecycle, synthesis, and synthetic
   cutover verification. Record real comparison samples only on separate
   approved non-production endpoints and distinct logical notifications;
   retain only cohort IDs and endpoint-reference digests. Never double-deliver
   one notification.

## Activate and cut over

1. Set the retained credential evidence reference, then enable the direct
   runtime through the protected deployment workflow while both cutovers still
   select Expo. Confirm startup and sanitized heartbeat evidence without a
   provider send.
2. In the authenticated integration settings, choose **Enabled** for
   `mobile-push` and enter the retained, non-secret direct-push verification
   reference that the protected deployment supplied to the running server. The
   audited `set-channel-enabled` capability requires that exact match, then
   atomically appends the new `mobile-push` `live-verified` status and enables
   its channel; it refuses an unverified deployment, a different reference,
   any other integration, or any other prior truth state. Never reuse the
   legacy `expo-push` reference. Confirm the readback shows the exact new status
   and enabled configuration before continuing.
3. After at least 100 classified attempts for the candidate provider/platform
   meet the five-second handoff p95 and have no duplicate or unclassified
   outcomes, and the Expo baseline and direct cohorts contain distinct cohort,
   endpoint-digest, attempt, and logical-notification IDs, an authenticated
   human may initiate the bounded physical drill. Automation must not initiate
   it.
4. Change only one platform from `expo` to `direct` in the exact canonical
   cutover JSON and deploy. Immediately publish a new complete staff roster
   snapshot. Publication fails closed if any active Expo endpoint in that
   platform lacks its paired direct endpoint. Read back sanitized endpoint
   counts by provider and do not declare cutover effective until the latest
   complete snapshot contains only the selected provider for that platform.
   Retained work continues on its pinned provider.
5. Observe append-only provider classification, queue age, unknown outcomes,
   endpoint retirements, and app-tap evidence. APNs `BadDeviceToken` or
   `Unregistered`, and FCM `UNREGISTERED` or token-level `INVALID_ARGUMENT`,
   may retire only the matching provider endpoint after durable failure
   evidence. Never retire on an ambiguous network result.
6. Repeat for the second platform only after the first remains bounded and
   explained.

## Rotate

Keep the platform cutover on Expo while replacing a direct credential. Update
one provider secret version, validate exact status and identity without
contents, deploy the worker, then perform only the already approved isolated
verification. Preserve old version metadata through the rollback window. If
validation fails, restore the preceding secret version and keep Expo selected.

## Roll back

Set the affected platform to `expo`, deploy normally, and publish a new complete
staff roster snapshot. Verify the latest snapshot's sanitized platform counts
select only Expo before declaring rollback effective. Do not edit endpoint,
attempt, event, or evidence history and do not replay ambiguous direct work.
Keep direct runtime authorization and credentials available while reconciling
already pinned direct work. Retain Expo fallback for seven calendar days after
both cutovers and until three bounded synthetic runs per platform complete with
zero unexplained `unknown` outcomes. Disabling the direct runtime is a later
separate action after that condition and queue reconciliation are proved.

Escalate **SEV-1** when push is the only verified launch channel, one
notification may have crossed two providers, classification is uncertain, or
unknown outcomes are broad.
