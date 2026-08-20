# Maintenance runbook: Google OAuth client-secret rotation

This runbook rotates the Google OIDC client used for staff sign-in. It does not
rotate the separate Google Groups roster-reader credential.

**Current truth:** Google OIDC is `blocked` in `docs/INTEGRATIONS.md`. The source
contract imports the independently retained `/psd-eoc/google-oauth` credential
by its complete ARN and separately creates
`/psd-eoc/google-oidc-cookie-secret`; neither change has been deployed or read
back, so exact runtime consumption is still unproven. There is no verified
deployment workflow, so production rotation execution is **BLOCKED BY #91**.

## Preconditions

- [ ] Product owner explicitly approved the exact live Google and production
      configuration change, consequence preview, operator, and rollback.
- [ ] The target account/region/environment and Google project/client are
      independently verified.
- [ ] Callback origins, hosted domain `psd401.net`, consent configuration, and
      least privilege were reviewed without adding scopes.
- [ ] A non-production environment isolated under #91 is available.
- [ ] The prior secret remains available for rollback, unless compromise
      requires immediate revocation.
- [ ] No secret value, client credential, user identity, or callback token is
      present in the ticket, shell history, screenshots, or repository.

## Planned rotation

1. Start an append-only change record with the current client identifier,
   runtime image digest, secret version ID (never the value), approval
   reference, maintenance window, and rollback owner.
2. In Google Cloud, create a replacement secret for the exact existing OAuth
   client when provider policy supports overlap. Do not create a second
   application, broaden redirect URIs, or change scopes to make rotation pass.
3. Store the replacement only as a new encrypted version of the approved
   retained secret, preserving exactly `clientId`, `clientSecret`,
   `iosBundleId`, `iosClientId`, and `webClientId`. The two public client IDs
   must remain distinct, share the web client's numeric project prefix, and
   retain bundle ID `net.psd401.eoc`; `clientId` and `webClientId` remain
   identical. Do not rotate or reuse the separate cookie-key secret as an OAuth
   client secret. Do not place any secret in environment text, a file, CI
   variable output, or a command line.
4. Deploy the exact reviewed application configuration so new instances read
   the replacement through `GOOGLE_OAUTH_CONFIG`. Supply only the no-default
   complete ARN parameter for the retained secret; never delete or recreate it.
   Because the repository has no approved deploy workflow, this step remains
   **BLOCKED BY #91**; do not improvise a console deployment.
5. In isolated non-production, verify one new staff-context synthetic sign-in,
   hosted-domain/group denial, CSRF/session handling, and that an existing
   long-lived session remains usable without a fresh Google round trip. No
   event or notification is required.
6. After the approved production rollout, verify health and one explicitly
   approved human sign-in without logging identity/token data. Retain the old
   secret through the documented rollback window.
7. Revoke the old Google secret only after the new version and rollback
   decision are proven. Record the provider's revocation timestamp and secret
   version IDs.

## Compromise path

Classify **SEV-0** if a client secret may be exposed. Preserve evidence, notify
the security/privacy lead and product owner, revoke the compromised secret
through the provider even if that temporarily blocks new sign-ins, and keep
existing sessions subject to normal server-side authorization/revocation.
Never weaken domain/group gates. Use the district security reporting process.

## Verification and rollback

Verify strict five-field runtime readback, new sign-in, denied-domain/group
behavior, existing-session continuity, application health, and no unexpected
roster/delivery impact. A successful readback advances the integration to at
most `configured-unverified`; only the separately approved exercised district
sign-in can justify `live-verified`. If new sign-in fails and the old secret is
still safe, redeploy the exact previous secret version and image/configuration
under the approved rollback. Do not re-enable a compromised secret. Append all
results and keep the integration truth label unchanged until separately
reviewed evidence justifies a change.
