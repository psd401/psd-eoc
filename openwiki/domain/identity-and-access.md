---
type: Domain Concept
title: Identity, sessions, roles, and facility scope
description: How staff sign in with Google OIDC on web and mobile, how Google Groups membership and direct admissions decide roles and facility scope, session and CSRF handling, and how agent API keys fit in as a separate principal kind.
tags: [auth, oidc, sessions, roles, facility-scope, google-groups]
openwiki:
  roles: [domain, architecture]
  change_kinds: [security, lifecycle]
  source_paths:
    - packages/server/lib/auth/oidc.ts
    - packages/server/lib/auth/sessions.ts
    - packages/server/lib/auth/session-cookie.ts
    - packages/server/lib/auth/middleware.ts
    - packages/server/lib/auth/trusted-group-access.ts
    - packages/server/lib/auth/live-membership.ts
    - packages/server/lib/auth/access-membership-sync.ts
    - packages/server/lib/auth/campus-scope.ts
    - packages/server/db/schema/identity.ts
  symbols: [facilityScopeFromGroups, MEMBERSHIP_FRESHNESS_MS, WEB_SESSION_COOKIE_NAME, WEB_CSRF_COOKIE_NAME, executeRepositoryAuditedOidcCompletion, resolveHumanCapabilityInvocation, campusMateFacilityIds]
  test_paths:
    - packages/server/lib/auth/oidc.test.ts
    - packages/server/lib/auth/sessions.test.ts
    - packages/server/lib/auth/trusted-group-access.test.ts
    - packages/server/lib/auth/sign-in-authorization.database.test.ts
    - packages/server/lib/auth/access-membership-sync.test.ts
  invariants:
    - Only an authenticated human acting in the app can perform the four human-only actions.
    - Group membership is re-read on every authorization and a stale membership fails closed.
    - A person acts at the union of all their groups; precedence is pinned by tests.
  validation_commands: [bun test packages/server/lib/auth/trusted-group-access.test.ts packages/server/lib/auth/sessions.test.ts]
---

# Identity, sessions, roles, and facility scope

**Consult this page** for sign-in, session lifetime/refresh/revocation, role or facility-scope rules, admissions, the Groups-based access sync, or app-review sign-in.

## Principals

`ActorSchema` kinds: `human`, `agent`, `system`. `InvocationSourceSchema`: `web`, `mobile`, `agent-rest`, `mcp`, `worker`, `scheduled-job`, `webhook`. `isActorSourceCompatible` pins which combinations are legal ([capability engine](../architecture/capability-engine.md)). Roles are only `staff` and `admin` (`RoleSchema` in `packages/contracts/src/shared.ts`); everything else is facility scope (`FacilityScope`: `{kind:'district'}` or `{kind:'facilities', facilityIds}`). Agents authenticate with API keys instead ([agent API and MCP](../integrations/agent-api-and-mcp.md)).

## Sign-in

- **Web**: `app/(auth)/auth/sign-in` → Google (OIDC, hosted-domain restricted via `GOOGLE_OIDC_HOSTED_DOMAIN`, `lib/auth/oidc.ts`, verified with `jose`) → `app/(auth)/auth/callback`. Cookies are `__Host-psd-eoc-session` (HttpOnly, Secure, SameSite=Strict) and a readable `__Host-psd-eoc-csrf` token (`lib/auth/middleware.ts`, `session-cookie.ts`); mutating web calls must pass CSRF.
- **Mobile**: `app/api/auth/mobile/oidc/{start,exchange}` implement a start-then-exchange authorization-code flow (flow token and state schemas in `oidc.ts`) for the native app ([mobile app](../integrations/mobile-app.md)); `app/api/auth/{refresh,revoke}` rotate and revoke tokens.
- **App-store review account**: `app/api/auth/mobile/app-review` + `lib/auth/app-review-sign-in.ts` signs in from a review code, held to the facility limit an admin set (runbook `docs/runbooks/app-store-review.md`).
- OIDC completion is the one pre-session capability: `complete-oidc-sign-in` via `executeRepositoryAuditedOidcCompletion`, whose serializable repository commits replay protection, session issuance and access-gate audit together; the call-site allowlist is in `capabilities/execution-boundary.test.ts`.
- **Sessions** (`lib/auth/sessions.ts`): default lifetime 90 days (`PSD_EOC_SESSION_LIFETIME_SECONDS`, bounded 1–365 days), refresh-token rotation with replay detection (tables `session_token_issuances/rotations/replays`, `session_revocations`), revocation staleness bound `MAX_REVOCATION_STALENESS_SECONDS` = 60, and per-device `connectivity_epochs` that the capability engine checks for mutations. `device_enrollments` and `device_push_token_registrations` tie sessions to devices; `installation-handoff.ts` ends push registrations when an installation changes hands.

## Who may sign in: groups and admissions

Access is derived from Google Groups membership captured by the scheduled access-membership sync (`sync-access-membership` capability; `access-membership-sync.ts`, `google-access-membership.ts`, ops script `packages/server/scripts/operations/sync-access-membership.ts`, ECS scheduled task `accessSyncSchedule` in the stack). Group sources (`group_sources`) have a **purpose**: `access` (grants district-wide access), `building` (a facility's staff roster, granting `staff`), `others`; `grantedRole` is `staff` or `admin`.

- `facilityScopeFromGroups(groups, admitted)` unions every usable group on every request: any `access` group → district scope; otherwise the set of `building` group facilities; a direct `admitted_accounts` admission carries no school and returns `null` (the stored limit decides). Admissions are created/revoked by admins (`admit-account`, `revoke-admitted-account`) and are how the first administrator gets in (`docs/guides/first-administrator.md`, `db/bootstrap-access.ts`).
- Freshness: stored membership authorizes sign-in only within `MEMBERSHIP_FRESHNESS_MS` (24 h) against a ~2-hour sync; `MEMBERSHIP_TTL`/`GRACE` seconds are configurable. Refusals are bounded codes (`NO_TRUSTED_GROUPS_CONFIGURED`, `NOT_IN_A_TRUSTED_GROUP`, `MEMBERSHIP_STALE`). `live-membership.ts` additionally reconciles against Google at request time and falls back to the stored membership when Google is unavailable; removing the last reachable administrator is refused (`role-state.ts`, `ADMIN_AVAILABILITY_LOCK_SQL`).
- **Campus rule**: an event reaches every school on its campus (neighborhood versions), so `campusMateFacilityIds` extends a facility-limited person's visibility to campus-mates, never to isolated facilities — the same rule as audience resolution in [roster and audience](roster-and-audience.md).
- A Google outage must not invalidate existing sessions or become a live dependency of activation (`docs/runbooks/roster-sync.md`).

## Change guidance

- Scope precedence changes: update `trusted-group-access.test.ts` (pinned precedence including admissions) and `sign-in-authorization.database.test.ts`.
- Session/token changes: `sessions.test.ts`, `session-cookie.test.ts`, `sign-in-session-round-trip.database.test.ts`; touching OIDC means checking the allowlisted routes in `execution-boundary.test.ts`.
- Never add client-side-only gating; authorization is server-side in the engine. Role/scope changes are audited facts (`user_role_changes`).
- Credential rotation: `docs/runbooks/rotation-google-oauth.md`. Database tests need the synthetic DB ([verification](../testing/verification-and-testing.md)).
