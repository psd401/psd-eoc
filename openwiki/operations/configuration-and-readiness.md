---
type: Operations Guide
title: Tenant configuration, readiness register, and runbooks
description: Where district-specific configuration lives (CDK context manifest, git-ignored cdk.local.json, runtime environment variables, mobile identifiers), how provider activation is gated, where current deployment and provider readiness is recorded, and how the runbook set is organized.
tags: [configuration, tenant, readiness, runbooks, open-source]
timestamp: 2026-11-01T10:45:46-08:00
openwiki:
  roles: [operations, delivery]
  change_kinds: [configuration, documentation-contract]
  source_paths:
    - docs/CONFIGURATION.md
    - docs/INTEGRATIONS.md
    - docs/runbooks/README.md
    - infra/cdk.json
    - infra/cdk.local.example.json
    - infra/src/tenant-context.ts
    - infra/src/stack/psd-eoc-stack.ts
    - infra/terraform/stateful/outputs.tf
    - packages/server/lib/config/deployment.ts
    - packages/server/lib/config/app-association.ts
    - packages/server/app/.well-known/apple-app-site-association/route.ts
    - packages/server/app/.well-known/assetlinks.json/route.ts
    - packages/mobile/app.config.ts
    - infra/src/stack/config.ts
    - scripts/verify-documentation.ts
    - scripts/verify-example-config.ts
  symbols: [readTenantContext, applicationOrigin, organizationName, staffHostedDomain, iosBundleId, displayTimeZone, readDeploymentIdentity, appleAppTeamId, androidApplicationId, androidSigningFingerprints, appleAppSiteAssociation, androidAssetLinks]
  test_paths:
    - infra/test/tenant-context.test.ts
    - infra/test/stack/psd-eoc-stack.test.ts
    - packages/server/lib/config/deployment.test.ts
    - packages/server/lib/config/app-association.test.ts
    - packages/mobile/scripts/distribution-config.test.ts
    - scripts/verify-documentation.test.ts
    - scripts/verify-example-config.test.ts
  invariants:
    - No district name, domain, account ID, region, bundle ID or hostname is a literal in source; all are configuration.
    - Current deployment and provider state is written only in docs/INTEGRATIONS.md.
    - An unconfigured store identity serves no association document; a malformed one is a configuration error, never a document a platform silently refuses.
  validation_commands:
    - bun run verify:config
    - bun run verify:docs
    - bun test packages/server/lib/config/app-association.test.ts packages/server/lib/config/deployment.test.ts
---

# Tenant configuration, readiness register, and runbooks

PSD EOC is open source and built so any district can run it on its own AWS account and Google Workspace ([architecture overview](../architecture/overview.md)). That rule shapes everything in this page: district identity is **configuration**, never source. The canonical, contract-checked documents are `docs/CONFIGURATION.md` (what to configure) and `docs/INTEGRATIONS.md` (what is currently true in a deployment); this page maps them and explains the rules around them.

**Consult this page when** adding a configuration key, wiring a new environment variable, touching tenant-specific values, changing provider activation gates, or deciding where a "is it live?" statement belongs.

## Configuration layers

| Layer | Where | Notes |
| --- | --- | --- |
| Shared CDK context | `infra/cdk.json` | Committed. Feature flags, the threat list, synthetic test groups only. |
| Tenant manifest | git-ignored `infra/cdk.local.json`, shape in `infra/cdk.local.example.json` | Every `psdEoc:*` key (organization name, hosted domain, application origin, facilities, neighborhoods, SES sender, SMS support contact, GCP project values, iOS bundle ID, optional Apple team ID and Android application ID and signing fingerprints behind the [association documents](#mobile-app-association-documents), monitoring runbook base URL, etc.). Read by `infra/src/tenant-context.ts` (`readTenantContext`). The AWS account ID, SMS support phone and GCP billing account never enter the repository. |
| CloudFormation parameters | passed to `cdk deploy --parameters` | Enable flags such as `EnableExpoPushWorker`, direct-push enablement, protected secrets paths; indexed in `docs/CONFIGURATION.md`. The three `PartnerUserPool*` parameters default to `UNCONFIGURED` and take their values from `terraform output stack_parameters` of the stateful root, whose tfvars inputs `ses_identity_domain`, `ses_region` (the region that holds that identity, which may differ from the pool's) and `partner_email_from_address` set the SES sender for partner email (see [partner email delivery](infrastructure.md#email-delivery-developer-ses-identity)); they are all-or-nothing and gated as described in [partner first-responder directory](infrastructure.md#partner-first-responder-directory-terraform-stateful-root). The proposed migration would turn these into typed Terraform variables with no defaults, fed from git-ignored tfvars and a GitHub `production` environment. Its phase 1 (the bootstrap root and the Terraform workflow) is built and has run against production per the readiness register; see [Terraform migration plan](infrastructure.md#terraform-migration-plan-phase-1-built-not-applied) and [Terraform state bootstrap and CI](terraform-ci-pipeline.md). |
| Server runtime environment | env vars read in `packages/server/lib/config/deployment.ts` | `GOOGLE_OIDC_APPLICATION_ORIGIN`, `GOOGLE_OIDC_HOSTED_DOMAIN`, `PSD_EOC_DISPLAY_TIME_ZONE`, `PSD_EOC_IOS_BUNDLE_ID`, `PSD_EOC_ORGANIZATION_NAME`, privacy/SMS contact values, `DATABASE_*`, and the optional `PSD_EOC_APPLE_APP_TEAM_ID`, `PSD_EOC_ANDROID_APPLICATION_ID` and `PSD_EOC_ANDROID_SIGNING_FINGERPRINTS` read by `appleAppTeamId`, `androidApplicationId` and `androidSigningFingerprints` for the [association documents](#mobile-app-association-documents). Readers accept an injected environment so tests can assert fail-closed behavior. Partner account mail reads `PSD_EOC_SES_FROM_ADDRESS` and `PSD_EOC_SES_CONFIGURATION_SET_NAME` in `packages/server/lib/partners/providers.ts`; the stack sets the set name to its partner set, and partner access stays off when either is missing ([partner mail](../domain/partner-access.md#partner-mail)). Partner web sign-in reads `PSD_EOC_PARTNER_USER_POOL_ID`, `PSD_EOC_PARTNER_USER_POOL_CLIENT_ID`, and `PSD_EOC_PARTNER_USER_POOL_CLIENT_SECRET_ARN` in `packages/server/lib/auth/identity-providers.ts`; with the pool id absent or `UNCONFIGURED` the sign-in page says the deployment has not enabled partner accounts ([partner web sign-in](../domain/partner-sign-in.md#configuration-and-readiness)). |
| Mobile build config | `packages/mobile/app.json`, `eas.json`, `EXPO_PUBLIC_*` | Replaced per district fork; bundle ID must match `psdEoc:iosBundleId`. `app.config.ts` derives the passkey associated domain and Android asset statement from `EXPO_PUBLIC_PSD_EOC_API_BASE_URL`, so no separate hostname is configured for the app. See [mobile app](../integrations/mobile-app.md). |
| Database rows | facilities, group sources, event types, channel configuration | Seeded by the deployment bootstrap ([infrastructure](infrastructure.md)); see [data model](../domain/data-model.md). |

Literals that deliberately remain: the mobile bundle identifier and keychain service names (renaming signs out every installed device), applied migrations, and leak-detector assertions (`git grep psd401 -- '*.ts' '*.tsx'` lists them). Test fixtures use invented districts; the suite itself runs as a synthetic district through `scripts/test-preload.ts` (`.invalid` domains) — see [testing](../testing/verification-and-testing.md). Do not add to the count of remaining literals.

## Documentation contracts (why docs edits can fail the gate)

`scripts/verify-documentation.ts` (`bun run verify:docs`) scans every Markdown file in the repository except the generated `openwiki/` tree, which `currentMarkdownFiles` skips because this wiki restates the sources rather than being one (pinned by the test "ignores the generated OpenWiki knowledge base" in `scripts/verify-documentation.test.ts`). It enforces, among others:

- relative links and anchors resolve; documented `bun run <script>` and `bun <file>.ts` commands exist;
- no hard-coded protected tenant identity (any 12-digit run other than the reserved unconfigured account, specific production hostnames/regions);
- volatile readiness claims (a status label asserted for a named boundary) live only in `docs/INTEGRATIONS.md`, and retention-schedule evidence only there;
- the CDK-context and environment lists in `docs/CONFIGURATION.md` (between `docs-contract` markers) match `infra/cdk.json` / `cdk.local.example.json`;
- records-retention policy lines (`automated-disposition: prohibited`, etc.) and no text authorising deletion/purge/lifecycle rules (see [data model](../domain/data-model.md#database-schema-migrations-and-append-only-rules)).

When adding a key to the manifest or env, update the marked list in `docs/CONFIGURATION.md` in the same change; `bun run verify:config` (`scripts/verify-example-config.ts`) checks `.env.example` parses into a valid synthetic deployment.

## Partner passkey relying party

A partner passkey is bound to one hostname, its relying-party id, and that hostname is configured in two places that must agree:

- **Server:** derived from `psdEoc:applicationOrigin` (runtime `GOOGLE_OIDC_APPLICATION_ORIGIN`) by `partnerRelyingPartyIdFromOrigin` in `packages/server/lib/auth/partner-passkey.ts`. An origin with a port, a path, or an address literal is refused, not used.
- **Pool:** the Terraform variable `passkey_relying_party_id` in `infra/terraform/stateful/variables.tf`, which feeds the pool's `web_authn_configuration` in `main.tf`. Its validation accepts only a public hostname.

Supply the host part of `psdEoc:applicationOrigin` (for `https://eoc.example.invalid`, `eoc.example.invalid`). A mismatch makes the server refuse every ceremony the pool offers (`requestOptionsFor`, `creationOptionsFor`), so passkey sign-in and enrollment become unavailable while the emailed code is unaffected. Changing the origin after partners have enrolled therefore invalidates their passkeys; they re-enroll on the next emailed-code sign-in, and no partner loses access. The full rule is in [docs/CONFIGURATION.md](../../docs/CONFIGURATION.md) (section "The partner passkey relying party"); the sign-in behavior is in [partner web sign-in](../domain/partner-sign-in.md#passkey-sign-in-and-enrollment-issue-599).

Narrow checks: `bun test packages/server/lib/auth/partner-passkey.test.ts` (the test `is the application origin’s own hostname` and `production uses the configured origin and development the request’s`), and `bun run verify:terraform` for the variable and the mocked `web_authn_configuration` assertion in `infra/terraform/stateful/tests/partner_user_pool.tftest.hcl`.

## Mobile app association documents

Each platform decides whether the app may ask the application origin for a passkey by fetching a document from that origin and checking it names the app. The deployment serves both documents, built in `packages/server/lib/config/app-association.ts` from three optional tenant keys (`psdEoc:appleAppTeamId`, `psdEoc:androidApplicationId`, `psdEoc:androidSigningFingerprints`):

- `/.well-known/apple-app-site-association` (`app/.well-known/apple-app-site-association/route.ts`) carries `webcredentials` for `<team id>.<iosBundleId>` and nothing else.
- `/.well-known/assetlinks.json` (`app/.well-known/assetlinks.json/route.ts`) carries one statement with `delegate_permission/common.get_login_creds` for the Android application id and up to four SHA-256 signing fingerprints. It deliberately omits `handle_all_urls`.

Behavior to preserve: with a key absent the document is a 404 and native passkeys are unavailable, while the emailed code still works; with only half of a pair configured (the Apple team without the bundle, or Android without its fingerprints) the document is also not served. A present but malformed value is an error on both sides: `readDeploymentIdentity` in `infra/src/stack/config.ts` fails the synth, and the server's readers in `lib/config/deployment.ts` throw `DeploymentConfigurationError`. The reason is that a malformed document is one Apple or Google silently refuses, which looks like a defect in the app. The web service receives each `PSD_EOC_*` value only when it is set (`infra/src/stack/psd-eoc-stack.ts`).

The documents are public and grant nothing. They say which app may ask for a credential; the partner admission still decides access ([partner web sign-in](../domain/partner-sign-in.md#native-passkey-sign-in-and-enrollment-issue-647)). Both are cached for an hour, but Apple and Google refresh on their own schedule. The documents are built from the same `psdEoc:applicationOrigin` as the passkey relying-party id, so the pool, the web ceremony and the documents cannot name different hostnames. The full rule is in [docs/CONFIGURATION.md](../../docs/CONFIGURATION.md#mobile-app-association-documents), and the runbook checks are in [partner access](../../docs/runbooks/partner-access.md).

Narrow checks: `bun test packages/server/lib/config/app-association.test.ts packages/server/lib/config/deployment.test.ts` (no database), `bun test infra/test/stack/psd-eoc-stack.test.ts` for the synthesized environment, and `bun run verify:docs` because the CDK-context list in `docs/CONFIGURATION.md` is contract-checked against `cdk.local.example.json`. Do not curl a live origin or run a store submission to validate; that is a human, post-deploy step.

## Provider activation gates (dark by default)

Live notification providers are separate, fail-closed activation boundaries documented in `docs/CONFIGURATION.md` and recorded in the register:

- **Expo push**: `EnableExpoPushWorker` (default false) plus protected secret with exact `verified` status and a non-secret evidence reference; mobile also needs the public build opt-in.
- **Direct APNs/FCM**: a second dark boundary on the same push worker, with a per-platform tenant cutover (`PSD_EOC_PUSH_PROVIDER_CUTOVER`, default Expo/Expo).
- **SES email** and **AWS End User Messaging SMS**: enabled channel configuration plus provider identities; SMS also needs carrier registration and per-staff consent.

These behaviors are implemented in [channel workers](../integrations/channel-workers.md) and provisioned in [infrastructure](infrastructure.md). Per `AGENTS.md`, never point a write-capable flow at a live provider without the product owner's explicit instruction in that session.

## Readiness register

`docs/INTEGRATIONS.md` (marked `<!-- psd-eoc:readiness-register -->`; exactly one such marker must exist) is the only place that states whether the web app, monitoring, OIDC, Groups access, EAS Build/Update/Submit, store installs, each push/email/SMS provider, media/exports, GuardDuty, map tiles and the agent surface are `mocked`, `configured-unverified`, `live-verified` or `blocked`, each backed by dated evidence. Rules: update an entry only from retained dated evidence; never infer live state from source or synthesis; runbooks and other docs link to it rather than copy status. This wiki intentionally does **not** restate statuses — read the register. It also holds the records-retention review (schedule sources and dates) behind [media, records and audit](../domain/media-records-and-audit.md).

## Runbooks

`docs/runbooks/README.md` is the index (about 40 procedures): stop conditions, first-run and go-live, rollback and emergency notification stop, backup/restore, release, one runbook per CloudWatch alarm family (anchors referenced from alarm descriptions via `psdEoc:monitoringRunbookBaseUrl`; preserve the `### Runbook:` headings in `infra/README.md`), provider setup/rotation (Expo, SES, SMS, direct push, Google OAuth, API keys) and roster sync. The verifier requires each runbook to link the readiness register (`../INTEGRATIONS.md`) and forbids dated readiness claims inside runbooks. Operational stop conditions mirror the safety rules: real/drill confusion, a real notification bypassing human confirmation, student data, secrets in unsafe places, provider acceptance presented as delivery, rewritten append-only history.

Guides for people rather than responders: `docs/guides/first-administrator.md` (getting the first admin admitted — see [identity and access](../domain/identity-and-access.md)) and the iOS/Android install guides. `docs/learnings/` holds dated failure-pattern notes (database, security, test failures, UI, workflow).

## Change recipes and checks

- **Add a tenant value**: add to `infra/cdk.local.example.json` (and `cdk.json` only if shareable), read it via `tenant-context.ts` or `lib/config/deployment.ts`, update the marked list in `docs/CONFIGURATION.md`. Checks: `bun run verify:config`, `bun run verify:docs`, `bun test infra/test/tenant-context.test.ts`.
- **Add an env var read by the server**: put the reader in `lib/config/deployment.ts` (injectable env), add it to `.env.example` if required for local runs, list it in `docs/CONFIGURATION.md`.
- **Record a new provider or deployment observation**: edit only `docs/INTEGRATIONS.md`, with dated evidence; leave runbooks status-free.
- **Escalate** to a full `bun run check` only when a change spans formatting, lint, docs contract and typecheck together; for docs-only edits `bun run verify:docs` is the narrow check.

## Known documentation drift (prefer source)

- `packages/mobile/README.md` still describes a protected per-build allowlist for push registration. It was removed and `docs/CONFIGURATION.md` says it is deliberately absent; see [mobile app](../integrations/mobile-app.md).
ONFIGURATION.md` says it is deliberately absent; see [mobile app](../integrations/mobile-app.md).
llowlist for push registration. It was removed and `docs/CONFIGURATION.md` says it is deliberately absent; see [mobile app](../integrations/mobile-app.md).
ONFIGURATION.md` says it is deliberately absent; see [mobile app](../integrations/mobile-app.md).
