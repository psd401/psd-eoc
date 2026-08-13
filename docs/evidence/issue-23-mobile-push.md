# Issue #23 mobile push evidence

Status: **physical-device evidence pending — Expo Push remains `mocked`**

This record must never contain credentials, push tokens, real recipient data,
or raw provider payloads. Automated evidence below proves only fail-closed code
behavior. It does not prove provider connectivity, operating-system delivery,
lock-screen appearance, or human receipt.

## Automated preflight

| Evidence                                                                                        | Result                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Strict receive payload rejects missing site/type and real/drill mismatch                        | Covered by contracts and mobile unit tests                               |
| Foreground malformed or visibly misclassified notification stays silent                         | Covered by `notification-content.test.ts`                                |
| Foreground/background/terminated taps queue exact canonical events until navigation succeeds    | Covered by `response-controller.test.ts`                                 |
| Missing/default build opt-in never requests permission or contacts Expo                         | Covered by `registration-controller.test.ts`                             |
| Native-token rotation is converted to a new Expo token before authenticated registration        | Covered by `registration-controller.test.ts`                             |
| Denial and disabled builds append token-free endpoint cleanup                                   | Covered by registration/server tests                                     |
| Sign-out validates the exact revocation receipt, fences races, then clears the local credential | Covered by mobile auth client/controller tests                           |
| Server revocation is append-only, device-scoped, replay-safe, and invalidates push endpoints    | Covered by server tests; PostgreSQL cases require CI `TEST_DATABASE_URL` |
| Queued/retried sends recheck token-free endpoint eligibility at the final Expo HTTP boundary    | Covered by worker, adapter, transport, and server route tests            |
| Accessible permission explanation and iOS/Android recovery instructions                         | Covered by `native-tests/push.native.tsx`                                |
| Android MAX/default-sound/vibration/public channel and iOS time-sensitive entitlement           | Covered by `native-config:push:check`                                    |

## Required authorization before a physical send

All of these must be recorded before either platform run:

- [ ] E6 / issue #40 provider credentials are verified without copying them here.
- [ ] Product owner approved an explicitly synthetic iOS target and synthetic Android target.
- [ ] Product owner explicitly authorized this live provider test run.
- [ ] The authenticated human reviewed a consequence preview identifying **DRILL**, the two synthetic targets, push only, and the exact visible copy.
- [ ] The authenticated human confirmed the send in the app; no automation invoked a human-only action.

Authorization reference: _pending_

Consequence-preview reference: _pending_

Authenticated human confirmation reference: _pending_

## iOS physical-device run

- Device model / OS (no serial or token): _pending_
- App build/profile and commit: _pending_
- Fresh install UTC: _pending_
- In-app explanation shown before OS prompt: _pending_
- Token registration receipt (token-free reference only): _pending_
- Synthetic **DRILL** notification lock-screen title begins `[DRILL]`: _pending_
- Foreground receipt and exact-event tap: _pending_
- Background receipt and exact-event tap: _pending_
- Terminated receipt and exact-event tap after unlock: _pending_
- Permission denial surfaced with iPhone Settings instructions: _pending_
- Sign-out/revocation removed endpoint and stale report showed `no-active-push-endpoint`: _pending_
- Redacted screenshots/artifact links: _pending_
- Witness and UTC: _pending_

## Android physical-device run

- Device model / OS (no serial or token): _pending_
- App build/profile and commit: _pending_
- Fresh install UTC: _pending_
- In-app explanation shown before OS prompt: _pending_
- `eoc-alerts` channel visible with required settings: _pending_
- Token registration receipt (token-free reference only): _pending_
- Synthetic **DRILL** notification lock-screen title begins `[DRILL]`: _pending_
- Foreground receipt and exact-event tap: _pending_
- Background receipt and exact-event tap: _pending_
- Terminated receipt and exact-event tap after unlock: _pending_
- Permission/channel denial surfaced with Android Settings instructions: _pending_
- Sign-out/revocation removed endpoint and stale report showed `no-active-push-endpoint`: _pending_
- Redacted screenshots/artifact links: _pending_
- Witness and UTC: _pending_

## Current blocker

As of 2026-08-13, Xcode detects a paired, available iPhone 15 Pro. The Android
SDK and `adb` are available and detect one running Android 16 emulator, but no
physical Android device. Neither device has a verified build from this issue's
current commit. E6 / issue #40 remains open with both human-input boxes and all
three completion boxes unchecked, including EAS push credentials and both
physical deliveries. No live send was attempted, the integration truth label
was not advanced, emulator evidence is not represented as physical evidence,
and the physical acceptance checkbox must remain open until both controlled
runs above are completed.
