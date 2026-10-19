# Maintenance runbook: agent API-key rotation

Current deployed agent-surface state lives only in the
[operational readiness register](../INTEGRATIONS.md).

PSD EOC agent API keys are scoped credentials whose grants come from the
explicit allowlist in `packages/contracts/src/agent-key-grants.ts`: reads,
records evidence, security-audit reads, previews and activation preparation,
unpublished template drafts, and synthetic-roster lifecycle. Publishing a
template version, writing journal entries, joining or reactivating an event,
reopening a closed event, and configuration writes are not grantable, and keys
can never receive the four human-only actions. Rotation uses the authenticated
human administrator interface and append-only issue/revocation evidence.

## Preconditions

- [ ] The human administrator is authorized for the exact agent and facility
      scope.
- [ ] The agent owner confirmed the smallest required capability set and key
      lifetime.
- [ ] A secure district secret store and a coordinated consumer cutover window
      are ready.
- [ ] The existing key ID, not its secret value, is recorded.
- [ ] No proposed grant contains a canonical human-only action or an ID
      outside the allowlist; the admin form offers only allowlisted IDs and
      the server refuses any other value.

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

## Rate-limit audit bursts

The agent gateway admits at most 60 requests per key per minute and 20 per key
per hour across `export-drill-records`, `export-event-summary`, and
`create-activation-preview`. Each server instance counts separately, so a key
can reach up to four times those figures across the deployment, and an
instance restart clears its counts. A refusal is an `access-denial` audit
fact with reason code `RATE_LIMITED` under the agent and key IDs; no
capability ran and nothing was created or exported. Only the first refusal of
a lockout is recorded, for either budget, so one fact can stand for many
refused requests.

Repeated `RATE_LIMITED` facts from one key mean the consumer behind that key
keeps exceeding its budget on one instance: usually a client retry loop, a
model calling the same tool repeatedly, or a job fanning out too widely. Read
the facts for that key just before each one to see what it was doing.

- Successful reads and exports before the refusal point to a loop or fan-out
  on the consumer side. Tell the key owner; no rotation is needed.
- `CAPABILITY_NOT_GRANTED` denials in the same run point to a consumer that
  is probing for grants it does not hold. Treat the key as a suspected
  compromise and revoke it first.
- A human-only attempt within the key's budget is recorded as
  `HUMAN_ONLY_REQUIRED`; past the budget it is refused, and the lockout's
  one fact is a `human-only-rejection` with reason code `RATE_LIMITED`
  naming the action. Either is **SEV-0** on its own.
- Refusals from several keys at once, or the same key on every instance, are
  a capacity signal rather than a key problem.

## Evidence

Record agent ID, old/new key IDs, facility and capability scope, expiry,
issuer/revoker human IDs, UTC issue/revoke times, secret-store record ID, and
verification result. Never record either key value. A failed audit append is
not success; stop and reconcile before continuing.
