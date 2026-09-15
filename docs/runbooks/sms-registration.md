# SMS carrier registration operations

Current registration, worker, and SMS delivery state lives only in the
[operational readiness register](../INTEGRATIONS.md). Registration never
enables the worker and never authorizes a live notification.

## Tool boundary

The operator tools under `scripts/ops/sms-registration` validate provider field
definitions, maintain a private append-only registration-state file, and
separate preview, submit, and status operations. Development and CI use mocks;
they do not authenticate to AWS or submit a registration.

Provider forms and eligibility policy can change. Treat live provider schemas
and responses as untrusted, fail closed on unknown fields or state, and do not
copy provider contact data into the repository. Tenant/account/region values
come from protected configuration rather than this runbook.

## Procedure

1. Confirm the current readiness row, exact protected account/region,
   registration kind, approved business identity, fees, and rollback/stop
   condition in the controlled operator system.
2. Run validation and preview before any submission. Keep private registration
   input and state outside the repository with owner-only permissions.
3. An authorized human may submit only the exact reviewed registration after
   the product owner's current-session approval. Never relabel the use case to
   bypass a provider policy.
4. Poll status through the canonical status tool. Normalize and bound provider
   feedback; missing or failed reads remain `unknown`.
5. Record only provider IDs, timestamps, status, and sanitized feedback. Update
   the readiness register only for the boundary actually proved.

An approved registration or allocated number is not proof of worker wiring,
provider acceptance, carrier delivery, or human receipt. Any controlled
synthetic send is a separate authenticated-human action and still may not use a
real incident, staff roster, or real recipient.

The dated tenant-specific discovery, provider-policy snapshot, input examples,
and historical commands are retained in the district's private operations
records, outside this repository.
