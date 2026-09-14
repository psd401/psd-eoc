# First run: from a deployed stack to a working drill

This is the ordered path a district follows once the infrastructure exists and
before anyone trusts the system with a real incident. It assumes the deploy
succeeded and `GET /api/health` returns `{"status":"ok"}`.

Confirm current deployment and identity state in the
[operational readiness register](../INTEGRATIONS.md) before starting.

Nothing here sends a notification. The last step is a drill, and a drill is
still an authenticated human confirming a consequence preview.

## What the deploy already gave you

`seedReferenceData` runs during bootstrap on every deploy. It is safe to run
repeatedly. On a fresh database it loads these catalogs and fail-closed
integration baselines:

| Seeded                 | Count |
| ---------------------- | ----- |
| Responses              | 12    |
| Response versions      | 12    |
| Response templates     | 108   |
| Integration statuses   | 6     |
| Channel configurations | 3     |

On an existing database, bootstrap preserves its append-only integration
history. It creates a baseline only for an integration with no history and
binds any missing, disabled channel configuration to that integration's latest
retained observation.

Read the list of what it does **not** create carefully, because every item on
it is work you still have to do: facilities, neighborhoods, group sources,
rosters, recipients, events. A deployment that has only been bootstrapped knows what
kinds of event exist and nothing about your district.

## 1. Get your first administrator in

See [first-administrator.md](../guides/first-administrator.md). In short: a
fresh deployment admits nobody, the page that configures access is behind
sign-in, and the circle is broken by supplying `InitialAccessGroupId` and
`InitialAccessGroupEmail`, plus optional `InitialAccessGroupName`, directly as
parameters to `cdk deploy`. The stack refuses a partial pair, and bootstrap
creates the group only when no access group exists.

## 2. Prove the membership sync is actually running

Do not skip this, and do not treat a successful first sign-in as proof.

Access is granted from each active access group's current membership rows and
`members_captured_at`. A group remains fresh for 24 hours after it was read
(`MEMBERSHIP_FRESHNESS_MS` in
`packages/server/lib/auth/trusted-group-access.ts`). Past that,
`decideAccess` refuses everyone with `MEMBERSHIP_STALE` — including you. A
deployment where sign-in works today but nothing refreshes membership is a
deployment that locks its district out tomorrow, and it looks healthy the whole
time.

That has already happened once in production here. It is the single most
important thing to verify on a new deployment.

**Check the schedule exists and is enabled:**

```bash
aws events describe-rule --name psd-eoc-access-membership-sync-every-two-hours --query '{state:State,schedule:ScheduleExpression}'
```

Expect `ENABLED` and `cron(0 */2 * * ? *)`. A two-hour interval well inside a
24-hour bound means several consecutive failures still deny nobody.

**Check membership is fresh.** In the database:

```sql
select display_name, active, members_captured_at,
       round((extract(epoch from (now() - members_captured_at))/3600)::numeric, 2) as hours_old
from group_sources where purpose = 'access';
```

An active group with `members_captured_at` null has never been read. One with
`hours_old` above 24 is already refusing sign-ins.

**When a sync fails, read why.** The task writes to CloudWatch log group
`/psd-eoc/bootstrap`, stream
`access-membership-sync/access-membership-sync/<task-id>`. A successful run
emits one aggregate line:

```json
{
  "event": "access-membership-sync-complete",
  "snapshotVersion": 176,
  "activeAccessGroupCount": 1,
  "evaluatedMembershipCount": 5,
  "publication": "created"
}
```

Counts and digests only — no address, member payload, group ID, or token. A
failure emits a single bounded line naming its code, for example
`GOOGLE_OIDC_HOSTED_DOMAIN must be configured.`

The failures worth recognising:

- **Missing configuration.** The task resolves every member address against
  your staff domain, so it needs `GOOGLE_OIDC_HOSTED_DOMAIN`. Without it the
  task fails closed on startup and no snapshot is published.
- **Missing provider credential.** The Google service-account key is read from
  Secrets Manager. If the secret does not exist, the container never starts and
  there are **no application logs at all** — the task simply stops. An empty
  log stream is itself the diagnosis; check the task's `stoppedReason` for a
  `ResourceInitializationError`.
- **A trigger nothing can satisfy.** If the sync is driven by anything
  requiring a human approval, a scheduled run cannot complete. Membership then
  ages out on a system that reports no errors, because nothing ran.

## 3. Enter your schools

Facilities come from `psdEoc:facilities` in the manifest, created by the
deploy's bootstrap; under **Facilities** you may also add one per building
staff can be assigned to and events can be started at. A facility marked
**isolated** reaches its own building sources only, never the district lists;
the only one a district normally needs is the site an app store reviewer runs
a drill at (see the [app store review account](app-store-review.md) runbook).

Then group them into neighborhoods — the set of schools notified together when
an event at one of them reaches beyond its own building.

## 4. Give each facility a building group

There is no audience to configure. The retired `audience_configurations` and
`audience_targets` tables no longer control delivery: an event at a school
reaches that school's staff, and that rule is enforced by current code rather
than a configuration row.

What decides whether an activation reaches anybody is the school's **building
group source** — an active Google group, `purpose = building`, bound to the
facility. Create one per facility you intend to start events at. The admin
readiness page reports how many active facilities still have none.

The quickest way is **Facilities → Register building groups by naming
convention**: every active school without a Google building source gets one
named by its short code, `<code>-eoc@` followed by the staff domain, and the
roster is published in the same step. A Google Group that does not exist yet,
or that Google could not be asked about because the server's credential is
missing or Google is unavailable, is registered as **waiting**: the source
names nobody until Google holds the group, and its ID is recorded and its
members read by the next scheduled membership sync once it exists. Google
answers a lookup of a group that does not exist with "permission denied (or
it may not exist)", the same answer as for a group the credential may not
read, so both are read as waiting; a group that resolves but is not an
exact, readable group still blocks the add. **Check waiting groups with Google** asks at
once which waiting groups Google holds now, without waiting for the schedule.
A new school added on that page gets its convention group the same way. An
others source must exist when it is registered; only building sources may
wait.

Each school is registered by its own call, so when Google fails part-way the
schools before it stay registered and the page says how many; press the
action again to continue with the rest. Two cases stay waiting on purpose:
a school whose short code changed keeps a waiting source at the old address,
so the action lists that school again and registers the new address beside
it; and a waiting group that turns out to be an alias of a group already
registered is not recorded, because one Google group backs one roster source.

## 5. Confirm the roster

The notification roster is separate from access. Access decides who may sign
in; the roster decides who receives a notification. They are built by different
jobs from different groups, and one working tells you nothing about the other.

Check under **Integrations** that the roster source is configured and a
snapshot exists before trusting a consequence preview's recipient count.

Every facility needs its own building source, because an event at a school
reaches that school's building source and no other. A person who must be
reached at every school, whichever one an event starts at, belongs on an
**others** source instead: it is a district-level list that every event
selects. Others sources come in two kinds. A Google others source draws its
membership from a Google Group; a manual others source is curated in the
application, on the Facilities page, with no Google Group, which suits a
fixed district responder list. Saving the people on a manual source publishes
the roster in the same request, or says why it could not: a refused
publication leaves the saved people in place and nothing changes who is reached
until a publish succeeds. A change to a Google Group takes effect when the
scheduled roster sync next publishes, or when an administrator publishes from
the Facilities page.

## 6. Walk the admin surface

| Section          | What it is for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access**       | Which Google Groups may sign in, and what role each grants. A group is registered by its address; its Google Group ID is looked up from Google when it is saved. A person's membership in those groups is confirmed with Google at every sign-in, so a change to a group takes effect the next time they sign in; the scheduled sync keeps everyone else current and stands in when Google cannot be asked. One Google group may be both a sign-in group and one roster source, so the district staff group can gate sign-in and be the every-event audience at once. Roles are derived from group membership on every request and never stored. An address may also be admitted here directly, as staff, without any group, for an account no group should hold; the admission is revocable in the same place. A person may be limited to some facilities here; the limit is enforced on every capability, not only in what they see. |
| **Facilities**   | Your schools, and the neighborhoods that group them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Responses**    | The responses staff may start once they have named the threat, and the versioned templates each one publishes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Devices**      | Enrolled mobile devices, and revocation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Integrations** | Per-channel enablement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Audit**        | The append-only, hash-chained security audit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Agents**       | Non-human capability access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### What a notification says

Every push, email, and text starts with the classification marker the
renderer owns, `[DRILL]` or `[INCIDENT]`, followed for an all-clear or a
reactivation by the state it announces (`ALL CLEAR:`, `REACTIVATED:`);
nothing an administrator types can remove or imitate it. After the lead
comes the response type's wording. The wording every response type starts
with names the response and the school, then who started the event and
when, the threat, and where to look; an all-clear names who completed it
and when. It lives in `packages/server/lib/notify/default-templates.ts`
and is what the Responses page offers for a new response type. Each
response type's wording is a versioned, immutable record: to change one,
publish a new version from the Responses page. To bring every response type
to the current default at once, run
`packages/server/scripts/operations/publish-message-templates.ts` in the
access-sync task definition with `MESSAGE_TEMPLATES_APPROVED_BY_USER_ID`
set to the approving administrator's user id; it supersedes only the
versions whose wording differs and reports what it published.

## 7. Run a drill

Start a drill, confirm the consequence preview names the recipients you expect,
run it through to an all-clear, and read the event journal afterwards.

A drill that reaches an all-clear with a recipient count matching your roster
is the first evidence the deployment works end to end. Until one has, every
other check above is necessary and none of them is sufficient.

## Readiness checklist

- [ ] `GET /api/health` returns `{"status":"ok"}`
- [ ] At least one **active** access group exists with a `granted_role`
- [ ] `members_captured_at` is populated and under 24 hours old
- [ ] The membership sync schedule is `ENABLED`, and its last run exited 0
- [ ] A human has signed in and arrived as an administrator
- [ ] Facilities exist for every building you will start events at
- [ ] Neighborhoods group those facilities
- [ ] Each facility has an active building group source
- [ ] A roster snapshot exists
- [ ] Alarm topics carry a **confirmed** subscription that reaches a person
- [ ] One drill has run to an all-clear

## If something is wrong

`first-administrator.md` has the sign-in troubleshooting order. For anything
else, the rule from `README.md` in this directory applies: stop, preserve
evidence, and escalate rather than bypassing a gate to see what happens.
