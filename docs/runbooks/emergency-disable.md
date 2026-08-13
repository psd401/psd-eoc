# Operations runbook: emergency-disable notification fan-out

Emergency disable is the fail-closed human control for stopping notification
fan-out. It does not start, all-clear, or close an event. It cannot recall a
handoff whose final locked authorization committed before disable. That check
is the handoff's linearization point: provider/SQS transport may begin or be
recorded after the disable timestamp even though the operation was already
admitted and in flight. Such outcomes may remain `unknown`; never call them
suppressed or recalled.

## Current status

Issue #34 owns the implementation and tests. A runbook or passing local test is
not deployed operational evidence. Until an approved deployment and readback
prove the control exists, production use is **BLOCKED** and go-live remains
blocked.

Required design truth:

- control entries are append-only;
- missing, unreadable, invalid, stale, or ambiguous truth fails disabled;
- only an authenticated human district administrator through the CSRF-verified
  web flow may change state;
- the capability is absent from REST/MCP agent grants and is not added to the
  canonical four-action agent surface;
- re-enable requires a fresh product-owner authorization reference and creates
  a new enable epoch;
- preview, activation/reactivation/all-clear mutation, outbox-to-SQS dispatch,
  and every worker provider-I/O boundary recheck current truth;
- disable terminally suppresses pending work; disable then re-enable never
  releases work created in an earlier epoch; and
- web and mobile activation surfaces show an honest prominent disabled or
  unavailable state.

### Dedicated worker authorization credential

Every provider-bound worker asks the application for a fresh authorization at
`POST /api/internal/fanout-control` immediately before provider I/O. The
application route accepts only the fixed `notification-fanout-worker` system
identity and the `authorize-notification-fanout` query; it cannot start, send,
all-clear, or close an event. The application reads its dedicated bearer from
`PSD_EOC_FANOUT_CONTROL_WORKER_TOKEN`. Each worker supplies that same secret
version only to its `FanoutControlClient` `bearerToken` option and uses the
exact approved HTTPS application origin for `serviceOrigin`.

This credential is only an internal query credential. Never reuse a database,
provider, delivery-writeback, interactive-session, or agent API credential.
Never place its value in a command, environment dump, ticket, log, screenshot,
evidence package, or this repository. The approved secrets service must inject
it into the application and workers at runtime.

Before go-live and after any rotation/deployment, two responders read back the
application and every provider-bound worker's runtime configuration. Record
only the secret resource reference and version ID, never the value. Prove that
all runtimes reference the same approved version, that workers use the exact
HTTPS service origin, and that no unrelated runtime receives the credential.
Also retain isolated negative-test evidence that a missing, invalid, or
mismatched credential returns an authorization failure and terminally
suppresses provider I/O. No approved deployment wiring or readback evidence
exists today, so this remains **BLOCKED BY #91**.

## Disable triggers

Disable immediately for any **SEV-0** safety stop, including possible
unapproved send, real/drill ambiguity, missing/contradictory control truth,
provider credential compromise, routable work on a blocked integration,
human-only/agent-boundary failure, or evidence that stale work can reach a
provider. Also disable when a **SEV-1** fan-out fault makes send consequences
unreliable and the product owner/incident lead chooses containment.

## Disable procedure

1. Assign an operations incident lead. Record UTC time, reason, reporter,
   environment, account/region, and the last provable control revision/epoch.
2. If the admin UI or control state cannot be read, treat fan-out as disabled
   immediately, announce that truth through the approved operations channel,
   and escalate. Do not bypass the control to create a record.
3. An authenticated human district administrator opens the PSD EOC emergency
   control page (`/emergency`) from a fresh CSRF-protected web session.
   Never use REST, MCP, a script, an agent key, a bookmarked mutation, or a GET
   request.
4. Verify the page shows the expected environment, current state, revision,
   enable epoch, and no conflicting entry. On mismatch or unreadable state,
   stop; the system remains disabled.
5. Review the consequence: new notification-generating lifecycle actions are
   refused, current-epoch pending outbox/queue work is terminally suppressed at
   every boundary, old work cannot be released later, and provider requests
   whose final locked authorization linearized before disable are already in
   flight and cannot be recalled.
6. Enter a bounded non-sensitive reason and the incident/change reference, then
   explicitly submit the CSRF-protected disable form to append the disabled entry.
   Never include message content, recipients, secrets, or provider payloads.
7. Read back the new entry ID, revision, disabled state, actor, reason, UTC
   time, and retained enable epoch. Append those IDs to the operations record.
8. From authenticated read-only surfaces, verify:
   - web and mobile show a prominent unavailable/disabled banner;
   - creation of a fresh consequence preview fails closed;
   - activation, reactivation, and all-clear notification mutation refuse
     execution;
   - eligible outbox dispatch stops and pending entries are recorded suppressed;
   - each central/channel worker rejects queued work before provider I/O; and
   - every provider/SQS operation observed after the disable timestamp maps to
     an immutable attempt whose final locked authorization linearized before
     the disabled record. Treat those operations as already in flight. Any
     authorization ordered after disable, or any uncorrelated call, is a
     **SEV-0** failure.
9. Read back the internal authorization configuration without exposing its
   value: the application and every provider-bound worker must reference the
   same approved dedicated secret version and exact HTTPS application origin.
   A missing or mismatched reference is a failed verification; keep fan-out
   disabled.
10. Do not exercise those checks with a real event. Use deployed read-only
    evidence and, after #91, an approved isolated synthetic fixture.

If any boundary continues provider I/O, treat as ongoing **SEV-0**. Revoke the
affected provider credential under its rotation runbook when authorized, keep
fan-out disabled, preserve immutable evidence, and open a gap.

## While disabled

- Keep event/journal history available read-only where safe. Never rewrite or
  delete it.
- Tell responders the notification system is unavailable; do not imply a
  message was sent. Normal district emergency/911 procedures remain separate.
- Classify pending and in-flight work truthfully. Suppressed work is not failed
  delivery, and provider-accepted is not receipt.
- Do not purge queues, redrive a DLQ, change epochs, edit control rows, or set a
  time-based auto-enable.
- Repair or roll back the proven cause and disposition every ambiguous attempt.

## Re-enable procedure

There is no automatic re-enable. A prior approval or the disable operator's
judgment is insufficient.

1. Prove the cause is resolved; all safety gaps have tests/evidence; integrations
   have honest truth labels; pending, queued, and ambiguous work is dispositioned;
   and web/mobile/provider boundaries are ready.
2. Obtain a **fresh explicit product-owner authorization reference** for the
   exact environment and re-enable consequence. Record approver, UTC time,
   evidence package, old epoch, and expected new epoch.
3. The authenticated human district administrator opens `/emergency` in
   a fresh CSRF-protected session. Confirm the disabled revision and complete
   consequence preview match the approval.
4. Explicitly submit the CSRF-protected re-enable form to append a new enabled
   entry. This form submission is not a human-confirmation record and does not
   send a notification. Read back its entry ID, revision, actor/time,
   authorization reference, and new enable epoch. Any mismatch fails disabled.
5. Verify old-epoch preview/outbox/queue work remains terminally suppressed and
   cannot reach any provider. Only work created through a fresh human decision
   in the new epoch can be eligible.
6. Verify banners and read-only control state reflect the new epoch. Do not
   start a real event or send a notification as a re-enable check.
7. Use the approved isolated synthetic non-production test after #91. Any live
   test remains a separate #30 human-confirmed action with every AGENTS.md gate.

## Evidence template

- Incident/change reference: `[REQUIRED]`
- Disable entry/revision/epoch and UTC time: `[REQUIRED]`
- Human administrator identity/role: `[REQUIRED]`
- Trigger and consequence preview: `[REQUIRED]`
- Boundary verification (UI, preview, lifecycle, outbox, central queue, push,
  email, SMS): `[REQUIRED]`
- Internal authorization secret resource/version readback for the application
  and every provider-bound worker: `[REQUIRED — NEVER RECORD THE VALUE]`
- Worker HTTPS service-origin readback: `[REQUIRED]`
- Missing/mismatched worker credential fail-closed evidence: `[REQUIRED]`
- Post-boundary provider-call count and in-flight unknowns: `[REQUIRED]`
- Root cause/fix/rollback evidence: `[REQUIRED]`
- Fresh product-owner re-enable authorization reference/time: `[REQUIRED]`
- New entry/revision/epoch: `[REQUIRED]`
- Old-epoch suppression proof: `[REQUIRED]`
- Access-controlled evidence link and second-responder review: `[REQUIRED]`

Append corrections. Never edit or delete an earlier control/evidence entry.
