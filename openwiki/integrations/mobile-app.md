---
type: Application
title: Mobile app (Expo, iOS and Android)
description: The packages/mobile native client, covering Expo Router structure, OIDC and secure-session handling, the start/activation flow, event room sync and photos, fail-closed push registration, and the dual-platform e2e and release rules.
tags: [mobile, expo, ios, android, push, oidc, e2e]
openwiki:
  roles: [integration, architecture]
  change_kinds: [mobile, push, auth, release]
  source_paths:
    - packages/mobile/app.config.ts
    - packages/mobile/app.json
    - packages/mobile/eas.json
    - packages/mobile/src/app
    - packages/mobile/src/lib/auth
    - packages/mobile/src/lib/api
    - packages/mobile/src/lib/push
    - packages/mobile/src/lib/start
    - packages/mobile/src/features/event-room
    - packages/mobile/src/features/sms-consent
    - packages/mobile/e2e/run.ts
  symbols: [AuthController, EventRoomSyncController, registration-controller, response-controller, start-mutation-coordinator]
  test_paths:
    - packages/mobile/native-tests
    - packages/mobile/src/lib/auth/auth-controller.test.ts
    - packages/mobile/src/features/event-room/sync-controller.test.ts
    - packages/mobile/src/lib/push/registration-controller.test.ts
    - packages/mobile/e2e/harness.test.ts
  invariants:
    - iOS and Android ship the same version; behavior changes land and are verified on both.
    - Push registration is off unless EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED is exactly "true"; there is deliberately no server-side per-build allowlist.
    - Mobile never forks business rules or performs real actions offline.
    - Sign-out requires successful server revocation and push cleanup before local SecureStore state is cleared.
  validation_commands:
    - bun run --cwd packages/mobile typecheck
    - bun test packages/mobile/src
---

# Mobile app (`packages/mobile`)

One Expo SDK 57 managed app for both stores (README: `packages/mobile/README.md`). It owns presentation, local session handling, and calls to canonical server APIs; domain types come from `@psd-eoc/contracts` and the server stays the only authority ([overview](../architecture/overview.md)).

## Structure

| Area | Where | Notes |
| --- | --- | --- |
| Navigation | `src/app` (Expo Router): `(auth)/sign-in`, `(auth)/unlock`, `auth/callback`, `(app)/events/*`, `(app)/text-alerts`, `start`, `preview/real`, `preview/drill` | Real and drill previews are separate routes so classification never blurs. |
| Auth | `src/lib/auth` (`AuthController`, `oidc-client`, `secure-session-store`, `local-authenticator`, `pending-oidc-flow`) | Server-driven native OIDC (`/api/auth/mobile/oidc/start` and `/exchange`, see [identity](../domain/identity-and-access.md)), authorization-code + PKCE via the `psdeoc` scheme. Session in SecureStore with device authentication (Face ID/passcode via OS; no custom PIN). Sign-out is online-only. |
| API | `src/lib/api` | `authenticated-request`, `forward-compatible-parse`, `client-diagnostics` (reports to `POST /api/diagnostics`; shipped connected from 1.0.10 per the readiness register). |
| Start flow | `src/lib/start`, `src/components/start` | Preview binding (`activation-preview-binding`), mutation coordinator/store, navigation and hardware-back guards that protect an in-flight activation. Calls `/api/mobile/start/{facilities,threats,preview,activate}` ([lifecycle](../domain/event-lifecycle-and-activation.md)). |
| Event room | `src/features/event-room` (`EventRoomSyncController`, `api.ts`, `model.ts`, `native-photo.ts`, `photo-draft.ts`) | Polls `sync-event-room`, posts journal entries and photos (EXIF stripping is server-side; see [media](../domain/media-records-and-audit.md)). |
| SMS consent | `src/features/sms-consent`, `src/app/(app)/text-alerts.tsx` | Calls `/api/sms-consent*`; see [notifications](../domain/notification-pipeline.md). |
| Push | `src/lib/push`, `src/notifications/alert-channel.ts` | See below. |
| Release diagnostics | `src/lib/release/update-diagnostic.ts`, `src/app/release-diagnostic.tsx` | EAS Update is `blocked` in the readiness register; builds ship embedded-only. |

## Push registration (fail-closed)

- Build opt-in switch `EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED`; `eas.json` forces `false` for `development` and `preview`, `true` only in `production`. Missing/malformed value = off: no permission prompt, no provider contact, and server endpoints are removed when authenticated.
- Production also needs the `GOOGLE_SERVICES_JSON` EAS file variable (read by `app.config.ts`); never commit it.
- On launch the app writes Expo's persisted auto-registration state to `{ isEnabled: false }` and avoids the `expo-notifications` barrel (Expo 57 evaluates auto-registration at import). The token flow (`expo-token.ts`, `registration-controller.ts`) runs only after opt-in, authenticated-online, permission and native-identity gates; one eight-second request to Expo's token endpoint, then one canonical `register-push-token` call that stores the native+Expo pair in one transaction.
- The app submits its build identity (platform, app ID, version, build number, EAS project UUID, update mode) and the server records it per registration (`devicePushTokenRegistrations`; rotation on a changed build in `lib/capabilities/devices.ts`). The per-build allowlist that `packages/mobile/README.md` still describes was removed (commit `e418b42`; `docs/CONFIGURATION.md` states it is deliberately absent), so do not reintroduce a per-release manual step. Activation is described in `docs/CONFIGURATION.md#expo-push-activation-boundary`. Expo vs direct APNs/FCM is chosen server-side per platform ([channel workers](channel-workers.md)); no mobile change is needed to cut over.
- Notification taps (running/background/terminated) are de-duplicated and routed only by canonical event ID (`response-controller.ts`); foreground display needs matching real/drill markers. Android channel `eoc-alerts`; iOS time-sensitive entitlement. Disabled permission/channel appends unregistration truth.
- Failed registration retries on its own (recent history); iOS adopts the UIScene life cycle.

## Verification

- Bun unit tests colocated in `src`; native Jest tests in `native-tests/*.native.tsx` (run through `bun scripts/test-mobile-native.ts` at the repo root and in the full gate; see [verification](../testing/verification-and-testing.md)).
- Config guards: `native-config:check` (event-room and push native config), `expo:check`, `react:check`.
- **Dual-platform e2e** (Maestro, synthetic only): `bun packages/mobile/e2e/run.ts ios` and `... android`, requires `PSD_EOC_E2E_SYNTHETIC_ONLY=true` plus synthetic fixture variables; mock push never gets a token. Run both for any behavior, copy, or flow change (AGENTS.md rule). CI: `.github/workflows/mobile-e2e.yml`. These are conditional/expensive checks.
- Release procedure: `docs/runbooks/release.md`, `appstore-setup.md`, `app-store-review.md`; install guides in `docs/guides/install-{ios,android}.md`. The bundle identifier and keychain service names are deliberate literals (renaming signs out installed devices).

## Change guidance

- New server-facing call: add the contract in `packages/contracts` first, parse with the shared schema (forward-compatible parsing for lists), then client in `src/lib/api` or a feature `api.ts`.
- Do not add platform-conditional behavior without a stated reason (keyboard insets/system fonts qualify).
- Accessibility for activation, timeline and all-clear is required in the same PR.
- Narrow checks: `bun run --cwd packages/mobile typecheck`, `bun test packages/mobile/src/<feature>`, and `bun run --cwd packages/mobile test:native -- --testPathPattern <name>`.
