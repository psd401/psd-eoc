# Alarm runbook: scheduled membership task failure

**Source-defined CloudWatch alarm names:**

- `psd-eoc-roster-membership-sync-failed`, paged to the operations topic; and
- `psd-eoc-access-membership-sync-failed`, paged to the critical topic.

Current deployment and alarm read-back state lives only in the
[operational readiness register](../INTEGRATIONS.md). Source-defined alarm
names are not deployment evidence.

## Meaning

The scheduled membership task runs every two hours in two legs. The sign-in
leg reads the Google groups that gate sign-in; the roster leg reads the Google
groups behind building and district roster sources. Each leg logs one summary
line; a failed leg logs one failure line. Both alarms count those failure lines
over one hour and alarm on the first one, treating a quiet hour as normal.

- **Roster leg** (`roster-membership-sync-failed`): the job still exits clean
  and sign-in is unaffected, so this alarm is the only signal that a building
  or district list has stopped refreshing. Activation keeps reaching the people
  from the last complete read.
- **Sign-in leg** (`Protected access-membership synchronization failed
closed`): the job failed. Sign-in itself still confirms each person with
  Google live at their next sign-in; stored membership stops authorizing
  anyone 24 hours after its last fresh read, so this is the path to a
  lockout and pages critical.

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

## Verify recovery

Both alarms return to `OK` an hour after the last failure line, and the next
scheduled run logs `access-membership-sync-complete` for `scope: access` and,
when a roster group is configured, for `scope: roster`.
