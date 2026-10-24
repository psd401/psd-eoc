---
type: Operations Guide
title: Tenant configuration, readiness register, and runbooks
description: Where district-specific configuration lives (CDK context manifest, git-ignored cdk.local.json, runtime environment variables, mobile identifiers), how provider activation is gated, where current deployment and provider readiness is recorded, and how the runbook set is organized.
tags: [configuration, tenant, readiness, runbooks, open-source]
timestamp: 2026-10-23T00:00:00Z
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
    - scripts/verify-documentation.ts
    - scripts/verify-example-config.ts
  symbols: [readTenantContext, applicationOrigin, organizationName, staffHostedDomain, iosBundleId, displayTimeZone]
  test_paths:
    - infra/test/tenant-context.test.ts
    - scripts/verify-documentation.test.ts
    - scripts/verify-example-config.test.ts
  invariants:
    - No district name, domain, account ID, region, bundle ID or hostname is a literal in source; all are configuration.
    - Current deployment and provider state is written only in docs/INTEGRATIONS.md.
  validation_commands:
    - bun run verify:config
    - bun run verify:docs
---

# Tenant configuration, readiness register, and runbooks

PSD EOC is open source and built so any district can run it on its own AWS account and Google Workspace ([architecture overview](../architecture/overview.md)). That rule shapes everything in this page: district identity is **configuration**, never source. The canonical, contract-checked documents are `docs/CONFIGURATION.md` (what to configure) and `docs/INTEGRATIONS.md` (what is currently true in a deployment); this page maps them and explains the rules around them.

**Consult this page when** adding a configuration key, wiring a new environment variable, touching tenant-specific values, changing provider activation gates, or deciding where a "is it live?" statement belongs.

## Configuration layers

| Layer | Where | Notes |
| --- | --- | --- |
| Shared CDK context | `infra/cdk.json` | Committed. Feature flags, the threat list, synthetic test groups only. |
| Tenant manifest | git-ignored `infra/cdk.local.json`, shape in `infra/cdk.local.example.json` | Every `psdEoc:*` key (organization name, hosted domain, application origin, facilities, neighborhoods, SES sender, SMS support contact, GCP project values, iOS bundle ID, monitoring runbook base URL, etc.). Read by `infra/src/tenant-context.ts` (`readTenantContext`). The AWS account ID, SMS support phone and GCP billing account never enter the repository. |
| CloudFormation parameters | passed to `cdk deploy --parameters` | Enable flags such as `EnableExpoPushWorker`, direct-push enablement, protected secrets paths; indexed in `docs/CONFIGURATION.md`. The three `PartnerUserPool*` parameters default to `UNCONFIGURED` and take their values from `terraform output stack_parameters` of the stateful root, whose tfvars inputs `ses_identity_domain`, `ses_region` (the region that holds that identity, which may differ from the pool's) and `partner_email_from_address` set the SES sender for partner email (see [partner email delivery](infrastructure.md#email-delivery-developer-ses-identity)); they are all-or-nothing and gated as described in [partner first-responder directory](infrastructure.md#partner-first-responder-directory-terraform-stateful-root). A proposed (unstarted) migration would turn these into typed Terraform variables with no defaults, fed from git-ignored tfvars and a GitHub `production` environment; see [proposed Terraform migration](infrastructure.md#proposed-terraform-migration-not-started). |
| Server runtime environment | env vars read in `packages/server/lib/config/deployment.ts` | `GOOGLE_OIDC_APPLICATION_ORIGIN`, `GOOGLE_OIDC_HOSTED_DOMAIN`, `PSD_EOC_DISPLAY_TIME_ZONE`, `PSD_EOC_IOS_BUNDLE_ID`, `PSD_EOC_ORGANIZATION_NAME`, privacy/SMS contact values, `DATABASE_*`. Readers accept an injected environment so tests can assert fail-closed behavior. |
| Mobile build config | `packages/mobile/app.json`, `eas.json`, `EXPO_PUBLIC_*` | Replaced per district fork; bundle ID must match `psdEoc:iosBundleId`. See [mobile app](../integrations/mobile-app.md). |
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
