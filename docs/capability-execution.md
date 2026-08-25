# Capability execution boundaries

Every capability is defined once in `packages/contracts/src/capability-catalog.ts`.
That definition owns its input and output schemas, operation, safety effect,
invocation policy, audit policy, and agent grantability. Public manifests and
database capability enums are derived from that definition.

`executeAuditedCapabilityTransaction` is the normal server boundary. Browser,
agent REST, MCP, and mobile adapters authenticate and parse HTTP input, then
hand the request to this engine for authorization, idempotency, transactional
execution, and append-only audit.

`invokeAuthorizedCapabilityHandler` is the lower contracts primitive. It does
not own a database transaction, idempotency record, or audit append. Production
may import it only at the following internal machine/provider boundaries,
where persistence is deliberately owned by the surrounding worker protocol:

- delivery-state reconciliation
- scheduled roster synchronization
- SES webhook ingestion
- notification dispatch, reconciliation, and SMS policy processing
- the access-membership synchronization operations script
- the audited server engine itself

`executeAuthorizedCapabilityQuery` is type-restricted to canonical query IDs,
so read-only application services can reuse the contracts authorizer without
creating a mutation side door. Event-type, session, and agent-key repositories
retain their specialized durable-idempotency protocols, but their mutations run
inside `executeAuditedCapabilityTransaction`; the outer engine-store
transaction appends audit before the domain write can commit.

OIDC completion is the single pre-session exception. It has no authenticated
actor or facility scope yet, and its established serializable repository
already commits replay protection, session issuance, and access-gate audit
together. `executeRepositoryAuditedOidcCompletion` accepts only the literal
`complete-oidc-sign-in` registration, and the boundary test limits its callers
to the browser callback and mobile exchange routes.

The source-boundary test holds this as an exact allowlist. Adding another
consumer requires moving the flow through the audited engine or deliberately
updating this document and the test together.

Shared capability services live under `packages/server/lib`; Next `app`
folders contain only authentication, bounded request parsing, capability
invocation, and HTTP/page response mapping.
