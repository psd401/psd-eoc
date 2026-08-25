# Finishing the access-model cutover

Written mid-migration so the remaining work is exact rather than rediscovered.

## Where this stopped

The trusted-group model is built and proven; it is not yet load-bearing.

Done and verified against PostgreSQL 16:

- `access_group_members` + `group_sources.members_captured_at` (migration 0017)
- `decideAccess` — in an active trusted group, read recently enough, roles the
  groups grant
- `authorizeSignIn` — that decision plus account resolution, roles derived not
  stored
- `group_sources.granted_role` (migration 0016), contract and admin capability
- the access sync publishes for the configured set and can add or remove groups

Still in place: `access-gate.ts`, the snapshot tables, and session pinning.

## The one blocker, precisely

`sessions.membership_snapshot_id` is `NOT NULL` with two foreign keys:

- `sessions_membership_snapshot_id_fkey` → `access_membership_snapshots(id)`
- `sessions_membership_user_fk` → `access_membership_members(snapshot_id, user_id)`

Every session is pinned to a snapshot generation. That is why the gate cannot
simply be deleted: `session-cookie.ts` (28 references) and `sessions.ts` (13)
validate against that pin at issuance, persistence, and refresh.

## Order of work

1. **Migration.** Drop both foreign keys and make `membership_snapshot_id`
   nullable. Do not drop the column yet — existing sessions reference it, and a
   nullable column lets old and new sessions coexist through one deploy.

2. **`GroupAuthorizedWebIdentity`** (`session-cookie.ts:82`). Replace
   `membershipSnapshot` and `membershipMember` with
   `{ groupSourceIds: readonly string[]; capturedAt: Date }` from
   `authorizeSignIn`.

3. **Refresh becomes a question, not a comparison.** The `snapshotGroupsMatch`
   block and the snapshot id/version equality checks all collapse into one call
   to `decideAccess` for the session's user. A session stays valid while its
   holder is still in a trusted group, and stops when they are not. This is the
   change that removes the most code.

4. **Callbacks.** `app/(auth)/auth/callback/route.ts` and
   `app/api/auth/mobile/oidc/exchange/route.ts` call `authorizeSignIn` instead
   of `checkAccessGate`.

5. **Delete** `access-gate.ts`. It has no callers at that point.

6. **Sync.** Replace generation publication with "replace this group's members,
   stamp `members_captured_at`". The snapshot tables can then be dropped.

## Deploy order — this part matters

Sign-in reads `access_group_members`. Deploying the cutover against an empty
table locks out everyone, not one account.

1. Apply migrations and **populate `access_group_members` first**, while the
   old gate is still serving. The current evaluated members are already correct:
   snapshot v172 holds the five `tsd-engineering@psd401.net` members.
2. Verify the table is populated and `members_captured_at` is fresh.
3. Then deploy the cutover.
4. Then deactivate the exploration fixture group and delete the `kjh_admin`
   fixture user. Neither can be removed before the cutover, because the old gate
   denies every existing user while a second access group is active.

## What this fixes

`hagelk@psd401.net` is a current member of `tsd-engineering@psd401.net` and has
been refused all along, because the old rule required membership in _every_
configured access group and the synthetic fixture was one of them.
