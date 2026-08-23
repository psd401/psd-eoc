# First run: from a deployed stack to a working drill

This is the ordered path a district follows once the infrastructure exists and
before anyone trusts the system with a real incident. It assumes the deploy
succeeded and `GET /api/health` returns `{"status":"ok"}`.

Nothing here sends a notification. The last step is a drill, and a drill is
still an authenticated human confirming a consequence preview.

## What the deploy already gave you

`seedReferenceData` runs during bootstrap on every deploy. It is safe to run
repeatedly and it loads catalogs only:

| Seeded                 | Count |
| ---------------------- | ----- |
| Event types            | 8     |
| Event type versions    | 8     |
| Event type templates   | 72    |
| Integration statuses   | 5     |
| Channel configurations | 3     |

Read the list of what it does **not** create carefully, because every item on
it is work you still have to do: facilities, neighborhoods, audiences, rosters,
recipients, events. A deployment that has only been bootstrapped knows what
kinds of event exist and nothing about your district.

## 1. Get your first administrator in

See [first-administrator.md](../guides/first-administrator.md). In short: a
fresh deployment admits nobody, the page that configures access is behind
sign-in, and the circle is broken by naming one Google Group in configuration —
the `INITIAL_ACCESS_GROUP_ID` environment variable and
`INITIAL_ACCESS_GROUP_EMAIL` environment secret in GitHub's `production`
environment, plus the optional `INITIAL_ACCESS_GROUP_NAME` variable. Run the
supported `Deploy` workflow once. Its preflight refuses a partial pair before
building or deploying, and its migration step creates the group only when no
access group exists. The job summary says whether it was created, already
existed, or was intentionally omitted.

## 2. Prove the membership sync is actually running

Do not skip this, and do not treat a successful first sign-in as proof.

Access is granted from a **membership snapshot**, and a snapshot is honoured
for 24 hours after it was read (`MEMBERSHIP_FRESHNESS_MS` in
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
`/psd-eoc/<deployment>/bootstrap`, stream
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

Nothing seeds facilities. Under **Facilities**, create one per building staff
can be assigned to and events can be started at.

Then group them into neighborhoods — the set of schools notified together when
an event at one of them reaches beyond its own building.

## 4. Give each facility an audience configuration

Recipient resolution currently reads a versioned audience configuration per
facility, and the consequence preview cannot resolve recipients without one.
Create one for each facility you intend to start events at.

> This step is scheduled to disappear. Issue #292 retires
> `audience_configurations` and `audience_targets` in favour of the domain that
> already exists — staff belong to schools, schools belong to neighborhoods.
> Until it lands, this configuration object has to be created.

## 5. Confirm the roster

The notification roster is separate from access. Access decides who may sign
in; the roster decides who receives a notification. They are built by different
jobs from different groups, and one working tells you nothing about the other.

Check under **Integrations** that the roster source is configured and a
snapshot exists before trusting a consequence preview's recipient count.

## 6. Walk the admin surface

| Section          | What it is for                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Access**       | Which Google Groups may sign in, and what role each grants. Roles are derived from group membership on every request and never stored. |
| **Facilities**   | Your schools, and the neighborhoods that group them.                                                                                   |
| **Event types**  | The kinds of event staff may start, and the versioned templates each one publishes.                                                    |
| **Devices**      | Enrolled mobile devices, and revocation.                                                                                               |
| **Integrations** | Per-provider configuration and truth labels.                                                                                           |
| **Audit**        | The append-only, hash-chained security audit.                                                                                          |
| **Agents**       | Non-human capability access.                                                                                                           |

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
- [ ] Each facility has an audience configuration
- [ ] A roster snapshot exists
- [ ] Alarm topics carry a **confirmed** subscription that reaches a person
- [ ] One drill has run to an all-clear

## If something is wrong

`first-administrator.md` has the sign-in troubleshooting order. For anything
else, the rule from `README.md` in this directory applies: stop, preserve
evidence, and escalate rather than bypassing a gate to see what happens.
