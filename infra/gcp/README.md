# Google Cloud identity operations

This directory owns the Google Cloud identity and read-only Groups
configuration used by a deployment. Current Google OIDC and Groups readiness
lives only in the
[operational readiness register](../../docs/INTEGRATIONS.md). The portable AWS,
tenant, and direct deployment parameters are indexed in
[CONFIGURATION.md](../../docs/CONFIGURATION.md).

## Source boundaries

- Terraform files in this directory define the Google project, APIs, service
  account, and least-privilege role bindings.
- `scripts/groups-contract.ts` validates the configured staff-only group
  contract.
- `scripts/run-guarded.sh` is the only supported launcher for local cloud
  operations. It pins the operator environment, rejects executable startup
  hooks, validates the Google project and AWS caller, and refuses direct
  unguarded execution.
- Google Groups and OAuth credentials are separate. Neither belongs in
  Terraform state, shell history, source, logs, or evidence.
- A successful Terraform plan, credential read, or standalone provider check
  does not prove deployed sign-in or scheduled roster synchronization.

## Operator workflow

1. Read the readiness register and identify the exact boundary being changed.
2. Confirm the configured project, hosted domain, OAuth clients, staff-only
   group inputs, AWS account/region, retained secret references, and rollback
   point in the protected operator system.
3. Run only the corresponding action exposed by `scripts/run-guarded.sh`.
   Provider and secret writes require the product owner's current-session
   authorization; a read-only inventory does not authorize a later write.
4. Keep downloaded credential files outside the repository with owner-only
   permissions, then remove them through the approved secure process after the
   guarded store/readback completes.
5. Record only bounded, non-secret evidence. Update the readiness register
   only for the boundary actually proved.

The prior tenant-specific setup transcript, phase assumptions, and provider
readbacks are preserved in the
[historical archive](../../docs/archive/infrastructure/gcp-README-2026-08-25.md).
