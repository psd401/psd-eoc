# Getting your first administrator in

A fresh deployment admits nobody. That is deliberate — access is decided by
membership in a Google Group your district controls, and until the deployment
knows which group that is, the correct answer to every sign-in is no.

This is how you tell it, once. Everything after this happens in the app.

## The circle you are breaking

Sign-in is two independent steps. Google OIDC proves who you are; the access
gate then asks whether that address is in an active **trusted group**. A
deployment with no trusted groups refuses everyone, including you — and the
page that configures trusted groups is behind sign-in.

So the first group is named in configuration, not in the app.

## What you need

1. A Google Group your district owns, containing the people who should
   administer this system. Its address, for example
   `eoc-administrators@yourdistrict.org`.
2. That group's identifier in Cloud Identity, which looks like
   `groups/03x8tuzt4fpsm6y`. You can read it from the Cloud Identity Groups
   API, or from the Google Admin console URL when viewing the group.
3. The service account this deployment uses to read Google Groups, already
   authorized for the Cloud Identity Groups API. Without it, the group exists
   but its membership is never read, and nobody signs in.

Anyone in this group becomes an administrator. Anyone removed from it stops
being one at their next sign-in. There is no separate list of administrators
in this system, and no way to make somebody an administrator except by group
membership — that is the whole design.

## Configure it

Set two environment variables on the deployment, alongside the database URL
and the OIDC client:

| Variable | Value |
|---|---|
| `PSD_EOC_INITIAL_ACCESS_GROUP_ID` | `03x8tuzt4fpsm6y` (a leading `groups/` is accepted and stripped) |
| `PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL` | `eoc-administrators@yourdistrict.org` |
| `PSD_EOC_INITIAL_ACCESS_GROUP_NAME` | Optional. Defaults to `Administrators`. |

Set both of the first two or neither. Setting one alone is refused at startup,
because the alternative is a deployment nobody can sign in to and no clue why.

## Deploy

Migrations run on deploy, and the initial group is created in the same step.
The deploy log says which of three things happened:

```
Created the initial access group for eoc-administrators@yourdistrict.org,
granting administrator. Members can sign in after the next membership sync.
```

```
Access groups already configured; 2 active. The initial-group configuration
was ignored.
```

```
No initial access group configured (PSD_EOC_INITIAL_ACCESS_GROUP_ID and
PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL are unset). Sign-in stays closed until an
access group exists.
```

This step only ever acts when the deployment has **no** access group at all —
not "none active", not "none matching". Once your district has configured
access, the variables are inert and can be left in place or removed. It cannot
lock anyone out.

## Wait for the first membership sync

Creating the group does not create its membership. The sync reads Google on a
schedule — every two hours by default — and writes who is in each group. Until
it has run once, the group grants nobody anything and sign-in still refuses
you, with `NOT_IN_A_TRUSTED_GROUP` rather than
`NO_TRUSTED_GROUPS_CONFIGURED`.

Run it immediately rather than waiting, through the `sync-access-membership`
scheduled job.

## Sign in

Go to the deployment and sign in with an account in that group. You arrive as
an administrator.

## After that

Everything else is in the app, under **Access**:

- Add more trusted groups. A group grants either `staff` or `admin`, so a
  typical district runs two: everyone who may use the system, and the smaller
  set who may configure it. Somebody in both gets both.
- Withdraw a group you no longer trust. The one change that is refused is the
  one that would leave nobody able to administer — you cannot deactivate the
  last group granting `admin` while you are reachable only through it.
- Change who administers by changing who is in the administrator group, in
  Google. This system has no separate role assignment, on purpose: a stored
  grant outlives the reason it was given, and there is no reliable moment to
  take it back.

## If nobody can sign in

Check, in this order:

1. **Is there an active access group?** No group, no access. The deploy log
   from the migration step says whether one was created.
2. **Has membership been read?** `group_sources.members_captured_at` is null
   until the first sync succeeds. Sign-in refuses with
   `NOT_IN_A_TRUSTED_GROUP`.
3. **Is the membership stale?** It is honoured for 24 hours after it was read.
   Past that, sign-in fails closed with `MEMBERSHIP_STALE` — check whether the
   sync is still running and whether the service account still has access to
   the Cloud Identity Groups API.
4. **Is the account disabled?** A disabled account is refused even while its
   groups would grant access, so an administrator can revoke one person
   without waiting on a provider change.

If you have locked yourself out entirely, insert a row into `group_sources`
with `purpose = 'access'`, `active = true`, `granted_role = 'admin'`, and your
group's identifier and address, then run the sync. That is the same thing the
configuration above does.
