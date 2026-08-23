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

Open the repository's **Settings → Environments → production** page. Add the
initial group with the same GitHub configuration surface the supported
`Deploy` workflow reads:

| GitHub setting               | Kind                           | Example value                                                |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------ |
| `INITIAL_ACCESS_GROUP_ID`    | Environment variable           | `groups/03x8tuzt4fpsm6y` (the leading `groups/` is optional) |
| `INITIAL_ACCESS_GROUP_EMAIL` | Environment secret             | `eoc-administrators@yourdistrict.org`                        |
| `INITIAL_ACCESS_GROUP_NAME`  | Environment variable, optional | `System administrators`                                      |

Set both the ID and email or neither. A name alone is also incomplete. The
workflow validates this before it builds an image or runs CDK, names the
missing setting, and never prints the configured email. The optional name
defaults to `Administrators` when omitted.

The workflow passes these settings to the stack's `InitialAccessGroupId`,
`InitialAccessGroupEmail`, and `InitialAccessGroupName` parameters. The email
parameter is `NoEcho`. The bootstrap task receives the corresponding
`PSD_EOC_INITIAL_ACCESS_GROUP_*` environment variables; operators do not set
those task variables separately.

## Deploy

Run the repository's `Deploy` workflow once, either by merging the configured
commit to `main` or with **Actions → Deploy → Run workflow**. There is no
separate bootstrap command and no database insert in the normal first-run
path. The workflow stages the task definition, runs migrations and bootstrap,
and only then promotes the application image.

The Actions job summary reports one of these outcomes without the group email:

- `created on this deploy`
- `already existed; no access history changed`
- `intentionally omitted`

This step only ever acts when the deployment has **no** access group at all —
not "none active", not "none matching". Once your district has configured
access, the settings are inert and can be left in place or removed. Removing
all three makes the next deploy pass explicit empty parameters, but it does not
change, replace, or remove any group or membership row.

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

If this is a fresh installation and there is no access group, correct the
GitHub settings and run `Deploy` again; the create-only bootstrap remains the
supported recovery path. If a group already exists, the bootstrap deliberately
will not supersede it. Treat that as an access-configuration incident, preserve
the existing rows and task logs, and repair the existing configuration through
the database administration process instead of inserting a competing group.
