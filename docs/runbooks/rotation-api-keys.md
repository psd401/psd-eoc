# Maintenance runbook: agent API-key rotation

Current deployed agent-surface state lives only in the
[operational readiness register](../INTEGRATIONS.md).

PSD EOC agent API keys are scoped credentials for read/report/draft and other
explicitly granted capabilities. They can never receive the four human-only
actions. Rotation uses the authenticated human administrator interface and
append-only issue/revocation evidence.

## Preconditions

- [ ] The human administrator is authorized for the exact agent and facility
      scope.
- [ ] The agent owner confirmed the smallest required capability set and key
      lifetime.
- [ ] A secure district secret store and a coordinated consumer cutover window
      are ready.
- [ ] The existing key ID, not its secret value, is recorded.
- [ ] No proposed grant contains a canonical human-only action.

## Planned rotation

1. Sign in as the human district administrator and open the agent
   administration page. Confirm the exact agent identity, facilities,
   capabilities, expiry, and current key IDs.
2. Issue one replacement key with the same or narrower scope and a bounded
   expiry. Review the consequence preview before confirming. An agent or
   automation may not issue its own replacement.
3. Copy the one-time secret directly into the approved secret store. Do not
   place it in chat, a ticket, shell history, source control, logs, or a
   screenshot. If storage is uncertain, revoke it and issue another; never ask
   the application to reveal it again.
4. Update the one intended consumer through its approved secret reference.
   Verify authentication and only the minimum read/report/draft capability on
   synthetic or non-sensitive data. Verify from deployed capability
   availability plus approved automated safety evidence that every human-only
   action remains denied; never submit a real critical action as a test.
5. Revoke the old key in the human admin page with a bounded reason code. Key
   history and revocation evidence remain append-only; never delete the key row
   or audit entries.
6. Confirm the old key is denied, the replacement remains facility/capability
   scoped, and recent audit entries show only the expected agent identity and
   operations.

## Suspected compromise

Revoke the affected key first, even if the consumer becomes unavailable.
Classify **SEV-0** if audit evidence suggests access outside granted scope, a
human-only attempt, student/recipient data access, or credential publication.
Preserve the audit chain, notify the security/privacy lead and product owner,
rotate any downstream secret the key could read, and follow district incident
reporting. Never broaden a replacement key to restore service quickly.

## Evidence

Record agent ID, old/new key IDs, facility and capability scope, expiry,
issuer/revoker human IDs, UTC issue/revoke times, secret-store record ID, and
verification result. Never record either key value. A failed audit append is
not success; stop and reconcile before continuing.
