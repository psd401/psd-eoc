# Amazon SES operations

Current SES, DNS, worker, and delivery state lives only in the
[operational readiness register](../INTEGRATIONS.md). Tenant identity, account,
region, sender domain, secret references, and deployment inputs come from
[CONFIGURATION.md](../CONFIGURATION.md), not this runbook.

## Boundaries

- The CDK source defines the retained SES identity, DKIM and MAIL FROM records,
  configuration set, event destination, and fail-closed worker permissions.
  Source definitions and synthesis are not deployment evidence.
- `scripts/ops/ses-production-access.ts` owns bounded production-access
  request handling. `scripts/ops/ses-verification.ts` owns read-only checks and
  the separately guarded synthetic send path.
- A production-access request, infrastructure deployment, configuration
  change, and controlled synthetic provider send are separate operations.
- Provider acceptance is not mailbox delivery, opening, or human receipt.

## Procedure

1. Confirm the exact protected account/region, configured sender identity,
   hosted zones, retained resources, current readiness row, and rollback point.
2. Use read-only inventory first. Verify account sending state, identity,
   DKIM, MAIL FROM, configuration-set binding, worker permission, and event
   evidence independently.
3. Apply infrastructure only through the supported GitHub Actions/OIDC path in
   [CONFIGURATION.md](../CONFIGURATION.md). Do not create parallel identities,
   zones, configuration sets, or manual send permissions.
4. Keep `EMAIL_WORKER_ENABLED=false` and the SES verification reference at
   `UNVERIFIED` until sender, production access, signed callback, suppression,
   queue/DLQ, and alarm evidence is retained. Then set the protected deployment
   inputs together and deploy the reviewed image. The encrypted SNS topic feeds
   a retained callback queue; its separately permissioned consumer uses the
   current callback-compatible image and has no provider-send authority.
5. In the running application, an authenticated administrator selects
   **Verify and enable email**. This appends integration truth bound to the
   deployed reference and enables the database channel; it does not send.
6. Prove the email queue DLQ, callback DLQ, and both worker-health alarms with
   synthetic failures in an isolated environment. Do not copy, inspect, purge,
   or redrive email-send payloads. A callback message may be redriven only to
   its callback source queue after the cause is fixed; server signature and
   idempotency checks remain mandatory.
7. A provider-connected delivery test requires a separately verified
   unroutable/test target and an authenticated human acting in the app after
   the product owner's current-session approval. Never use a roster, incident
   template, real message, or arbitrary console send.
8. The first real one-recipient DRILL proof is a human acceptance step after
   deployment. Verify the exact preview count and DRILL rendering before the
   human submit, then retain queued → provider accepted → delivered or bounced
   evidence. Automation never performs this send.
9. Preserve bounded provider results and append-only delivery evidence. Update
   the readiness register only for the exact boundary proved.

The dated tenant-specific inventory, setup fields, and historical command
transcript are preserved in the
[archive](../archive/runbooks/email-setup-2026-08-25.md).
