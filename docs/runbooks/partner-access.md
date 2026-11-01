# Partner access rollout and administration

This procedure turns on sign-in and alerting for admitted non-district first
responders (partners), and then covers the day-to-day admission work. It does
not record current state. Whether the pool exists, which parameters are
deployed, and what has been verified live are recorded only in the
[operational readiness register](../INTEGRATIONS.md#partner-first-responder-sign-in).
Each numbered step is run by a person. An agent may prepare and verify, but
never applies Terraform, runs `cdk deploy`, or invites a partner.

How partner access works is described in the OpenWiki:
[admissions and the sweep](../../openwiki/domain/partner-access.md),
[web sign-in](../../openwiki/domain/partner-sign-in.md),
[alert settings](../../openwiki/domain/partner-alert-settings.md), and
[audience and delivery](../../openwiki/domain/partner-audience.md).

## Stop conditions

In addition to the [runbook stop conditions](README.md#stop-conditions), stop
and roll back the partner parameters ([Rollback](#rollback)) when:

- staff Google sign-in changes in any way after a partner deploy;
- a partner session can start, end, or administer an event, or reaches an
  isolated facility;
- a drill, test, or synthetic-training send reaches a partner; or
- a partner receives an alert for a response or threat the
  [partner alert settings](#alert-settings) do not select.

## Deploy order

The order matters. The contracts change for partner sessions (#592) altered
schemas the installed mobile apps parse, and a contracts deploy that reached
installed apps first broke every app's start flow once before (#470).

1. **Terraform state bootstrap.** One local apply of
   [state-bootstrap](../../infra/terraform/state-bootstrap/README.md) by a
   person with account administrator rights, then wire the GitHub
   `production` environment and repository secrets it describes. Skip this
   step if the readiness register shows it was already applied.
2. **Partner pool.** Merge the reviewed
   [stateful root](../../infra/terraform/stateful/README.md) tfvars change and
   approve the `production` environment run of the
   [Terraform workflow](../../.github/workflows/terraform.yml). Nobody applies
   this root locally. Set the `owner` variable to the app's mail group (the
   group behind the stack's `psdEoc:sesFromAddress`); it is both the `psd:owner` tag and the one email
   subscriber to the pool's bounce, complaint and reject events.
3. **Confirm the owner subscription.** SNS mails the owner group a confirmation.
   Confirm it with
   `aws sns confirm-subscription --authenticate-on-unsubscribe true` and the
   token from that mail, not by clicking the link: a link-confirmed
   subscription can be dropped by an unauthenticated unsubscribe. Then remove
   any older subscription on the same topic (for example a team group used before the app's mail group existed).
   The owner group must accept mail from outside the organization, because SNS sends
   from `no-reply@sns.amazonaws.com`.
4. **Record the pool.** Read `terraform output stack_parameters` from the
   apply run and record the dated evidence in the readiness register: pool
   id, app-client id, and the secret ARN's path. Never record the secret.
5. **Mobile build first.** Confirm the newest build on TestFlight and on
   Google Play was built from a commit that contains #592 (partner session
   contracts) or later. If it was not, ship one through the
   [mobile release](release.md) procedure, on iOS and Android together, and
   wait until both stores serve it before continuing.
6. **Database migrations.** Migrations `0062` through `0065` (partner alert
   settings, the partner notification population, the partner audience, and
   append-only delivery facts) ship with the release. Run the release outside
   an active incident: `0063` holds exclusive locks on five delivery tables
   while it applies, and activations wait until it finishes.
7. **Server deploy.** Run `cdk deploy` with the three `PartnerUserPool*`
   parameters from step 4 and `ProvisionApplication=true`, as described in
   [CONFIGURATION.md](../CONFIGURATION.md). The same deploy adds the partner
   SES configuration set's alert event destination and lets the email worker
   send under it; without this deploy, SES refuses partner alert email.
8. **Staff sign-in unchanged.** Immediately after the deploy, sign in as a
   staff member with district Google on the web and on one phone of each
   platform. If anything differs, stop and [roll back](#rollback).
9. **First partner.** Invite one known partner ([Invite](#invite)). Verify,
   with screenshots in the access-controlled evidence location:
   - email one-time-code sign-in on the web;
   - the partner cannot start, end, or administer an event;
   - a drill at a non-isolated facility is visible and the partner can post;
   - an isolated facility is not visible.

   Then, once a store build from a commit containing #598 serves both
   platforms, verify the same on one phone of each platform.

10. **Passkeys, if the app is in the stores.** Native passkeys need the
    association documents and a store build, so confirm this after step 7 and
    only on a build that contains #647:
    - `curl -s https://<application origin>/.well-known/apple-app-site-association`
      answers the `webcredentials` document, and
      `curl -s https://<application origin>/.well-known/assetlinks.json`
      answers one `get_login_creds` statement. A 404 from either means the
      tenant keys in [CONFIGURATION.md](../CONFIGURATION.md#mobile-app-association-documents)
      are not configured; the emailed code is unaffected.
    - On one phone of each platform, sign the test partner in with the
      emailed code, accept the offer to add a passkey, sign out, and sign in
      again from the same address. The second sign-in should use the passkey
      and send no mail. Record both platforms in the readiness register.
    - If either platform's ceremony is refused, the partner signs in with the
      emailed code exactly as before. Nothing needs rolling back; record what
      the platform reported.

11. **Alerts.** In a controlled test agreed with the partner's agency, start a
    real Lockdown-response event that the alert settings select and confirm
    the partner receives it. Separately, run a Lockdown drill and confirm the
    partner receives nothing. Record both in the readiness register.

## Invite

On the Access page's **Partners** section, an administrator fills in
**Invite a partner** (name, agency, and agency email address) and chooses
**Invite partner**. The app refuses a district address, an
address a staff Google identity already uses, and an address that already has
an unended admission. The invitation creates an admission that expires one
calendar year later, then enables the partner's account in the partner pool
and emails the invitation. If the provider or the email fails, the admission
stays and the row shows a pending step; use **Retry pending change**. Use
**Resend invitation** if the partner did not receive the mail.

To correct an address, use **Replace with corrected address** on the
partner's row. The old admission ends as replaced in the same step.

## Disable

Use **Disable** on the partner's row. The partner is cut out of the app at
once: every session is revoked, their device push registrations end, and
their text consent is withdrawn. The partner pool account is then disabled
and signed out everywhere. If the row still shows a pending `disable` step,
use **Retry pending change**. **Re-invite** creates a new admission for a
disabled or expired partner; it never reopens the old one.

## Expiry and renewal

An admission expires one year after it was granted, and access ends at that
instant. The daily partner-access sweep (`psd-eoc-partner-access-sweep-daily`)
then records the expiry, finishes any pending provider disable, and sends one
expiry notice 14 days before the date. Once a quarter it mails administrators
a review of partners who never signed in or have not signed in for 90 days;
the review never disables anyone. The sweep task exits with an error, and its
alarm fires, while any provider change or notice is still pending.

To renew, use **Renew for one year** on the partner's row. The partner's
open session keeps working. A partner whose access
has expired asks their district contact to be re-invited; there is no
self-service request.

## Alert settings

The **Partner alerts** admin page selects which responses alert partners
(default Lockdown and Modified Lockdown) and which threats never do. Saving no
responses turns partner alerts off without a deploy. Drills, tests and
isolated facilities never reach partners. A changed setting applies to the
next live incident; an event already started keeps the partners its
activation pinned, for its all-clear and reactivation too.

## Text opt-out

A partner who texts STOP is recorded against their partner endpoint, and the
next partner text batch leaves them out without a provider call. START
restores them. The **Text alerts** column on the Partners table shows
**Not signed up**, **Signed up**, or **Opted out — replied STOP**. STOP applies to the number, so
two partners sharing one number opt out together.

## Rollback

Deploy again with the three `PartnerUserPool*` parameters back at
`UNCONFIGURED`. Partner sign-in then refuses cleanly, the sweep skips, and
staff behavior is unchanged; nothing else needs undoing. To stop partner
alerts only, save the partner alert settings with no responses. To stop
native passkeys only, remove `psdEoc:appleAppTeamId`,
`psdEoc:androidApplicationId` and `psdEoc:androidSigningFingerprints` from the
tenant manifest and deploy: the association documents stop being served, every
partner falls back to the emailed code on their next sign-in, and no partner
loses access. The mobile build is backward-compatible and stays in the
stores. The partner pool and its
Terraform state stay in place; deleting them is a separate, reviewed change.
