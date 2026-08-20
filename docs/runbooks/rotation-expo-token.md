# Maintenance runbook: Expo access-token rotation

This runbook rotates the server-side credential used by the push worker. A
mobile EAS build token is a separate distribution concern and must not be
placed in the notification worker.

**Current truth:** Expo Push is `mocked`. The deployable stack creates
`/psd-eoc/expo-access-token` as an unusable placeholder and deliberately does
not expose it to App Runner. No production worker/event-source runtime is
deployed, so execution is **BLOCKED BY #91**.

## Preconditions

- [ ] Product owner approved the exact live provider configuration change,
      consequence preview, operator, rollback, and approved synthetic validation
      target if any provider request could send.
- [ ] The exact Expo account/project and least-privilege token policy were
      independently verified.
- [ ] The new token can be stored only in the approved encrypted secrets
      system; it will never be printed, committed, or exposed to App Runner/mobile.
- [ ] An isolated non-production worker with provably unroutable synthetic
      endpoints exists under #91.

## Planned rotation

1. Start an append-only change record containing token identifiers only,
   worker image digest, secret version ID, approval reference, window, and
   rollback owner.
2. Create a new least-privilege Expo token for the exact PSD EOC project. Keep
   the old token active for rollback unless compromise requires immediate
   revocation.
3. Store the new value as a new encrypted secret version and update only the
   push worker's approved runtime reference. The current repository has no
   deployed worker path; this step remains **BLOCKED BY #91**.
4. Verify in isolated non-production that the worker authenticates only at the
   push provider boundary, rejects staff/routable targets, preserves
   real/drill markers, and sends zero provider requests under mocked truth.
5. If a provider-connected synthetic check is separately authorized, it still
   requires verified credentials, the exact approved unroutable/synthetic
   target, a consequence preview, and fresh authenticated-human confirmation.
   Rotation approval alone is not send approval.
6. Roll out the exact worker image/configuration. Observe push queue/DLQ and
   bounded reason codes without logging device tokens or responses.
7. After the rollback window and reviewed evidence, revoke the old token and
   record provider revocation time and secret version IDs.

## Compromise and rollback

For suspected token compromise, classify **SEV-0**, revoke the token, and keep
push disabled until a replacement is explicitly authorized. Do not use the old token for rollback. For a non-compromise
rotation failure, restore the exact prior safe secret version and worker
configuration under the approved rollback. Never replay queued/unknown push
attempts to test the credential.
