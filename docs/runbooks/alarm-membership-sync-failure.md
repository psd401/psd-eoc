# Alarm runbook: scheduled membership task failure

**Source-defined CloudWatch alarm names:**

- `psd-eoc-roster-membership-sync-failed`, paged to the operations topic; and
- `psd-eoc-access-membership-sync-failed`, paged to the critical topic.

Current deployment and alarm read-back state lives only in the
[operational readiness register](../INTEGRATIONS.md). Source-defined alarm
names are not deployment evidence.

## Meaning

The scheduled membership task runs every two hours in three legs. The sign-in
leg reads the Google groups that gate sign-in; the roster leg reads the Google
groups behind building and district roster sources; the publish leg then
publishes a roster snapshot from whatever those sources now name. Each leg logs one summary
line; a failed leg logs one failure line. Both alarms count those failure lines
over two hours, one scheduled run, and alarm on the first one, treating a quiet
period as normal.

- **Roster leg** (`roster-membership-sync-failed`): the job still exits clean
  and sign-in is unaffected, so this alarm is the only signal that a building
  or district list has stopped refreshing. Activation keeps reaching the people
  from the last complete read.
- **Sign-in leg** (`Protected access-membership synchronization failed
closed`): the job failed. Sign-in itself still confirms each person with
  Google live at their next sign-in; stored membership stops authorizing
  anyone 24 hours after its last fresh read, so this is the path to a
  lockout and pages critical.
- **Publish leg** (`psd-eoc-scheduled-roster-publish-failed`): membership was
  refreshed but no snapshot was published, so an activation keeps resolving
  against the previous one. Anyone added or removed since is wrong in it. Two
  events feed this alarm and both mean the same thing:
  `scheduled-roster-publish-failed` is a publication that threw, and
  `scheduled-roster-publish-complete` with `"kind":"refused"` is one a
  completeness guard stopped. A `"kind":"skipped"` line is not counted: it
  means no building source is configured yet, which is not a fault.

## Safety posture

- Staff data only. Never paste group membership into a ticket or repository
  file; the task logs counts and digests, never addresses.
- Do not run the task by hand with the scheduled idempotency key: a run in the
  same two-hour bucket replays the earlier result. An on-demand run pins its
  own `ACCESS_SYNC_IDEMPOTENCY_KEY` and `ACCESS_SYNC_REQUEST_ID`.
- Never edit `group_sources` or `group_members` directly.

## Respond

1. Read the task's latest log stream in the bootstrap log group (stream prefix
   `access-membership-sync`) and note the failure code on the failure line.
   The codes are the evaluator's: `DESIGNATED_GROUP_IDENTITY_INVALID` (the
   group no longer resolves to its recorded ID), `NON_STAFF_MEMBERSHIP` (a
   member outside the staff domain), `NESTED_OR_NON_USER_MEMBERSHIP`,
   `GROUP_MEMBER_LIMIT_EXCEEDED`, `GOOGLE_REQUEST_REJECTED`,
   `GOOGLE_UNAVAILABLE`, or a configuration code.
2. For a group-shaped code, fix the group in Google Workspace (remove the
   external or nested member, or re-register the group by address on the
   Access or Facilities page if it was recreated). For a provider code, check
   Google Workspace status and the roster-reader credential in
   `docs/INTEGRATIONS.md`.
3. Run the task on demand with a pinned key and request ID, or wait for the
   next scheduled run, and confirm both summary lines appear.
4. For the sign-in leg, check the age of the last fresh read against the
   24-hour bound and escalate **SEV-2** while it is unresolved; **SEV-1** once
   within two hours of the bound.

### Publish leg refused

Read the `scheduled-roster-publish-complete` line's `errorCodes`. A refusal is
the completeness guard working, not a bug in it: the previous complete snapshot
stays authoritative rather than being replaced by one that reaches fewer people.

- `EMPTY_BUILDING_GROUP` — a building source now resolves to nobody. Confirm
  whether that is true before treating it as an outage; if it is not, the
  source's membership is what to fix. A Google building source still
  **waiting** for Google to hold its group is expected to name nobody and is
  not refused; it shows as waiting on the Facilities page.
- `SUSPICIOUS_BUILDING_GROUP_DROP` — membership fell far enough to look like a
  bad read. Confirm the drop is intended, then publish once from
  **Facilities → Publish the roster** to accept it.

Publishing by hand is the immediate override; it does not fix the cause, and
the next scheduled run will refuse again until the source is right.

## Verify recovery

Both alarms return to `OK` once a full two-hour period passes with no failure
line, which means a scheduled run completed without one, and that run logs `access-membership-sync-complete` for `scope: access` and,
when a roster group is configured, for `scope: roster`.
