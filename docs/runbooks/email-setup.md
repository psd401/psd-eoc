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
4. A provider-connected synthetic test requires a separately verified
   unroutable/test target and an authenticated human acting in the app after
   the product owner's current-session approval. Never use a roster, incident
   template, real message, or arbitrary console send.
5. Preserve bounded provider results and append-only delivery evidence. Update
   the readiness register only for the exact boundary proved.

The dated tenant-specific inventory, setup fields, and historical command
transcript are preserved in the
[archive](../archive/runbooks/email-setup-2026-08-25.md).
