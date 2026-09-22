# PSD EOC mobile

The PSD EOC native client is an Expo SDK 57 managed app for iOS and Android.
Expo Router owns navigation. Shared domain types come from
`@psd-eoc/contracts`; mobile code must not redefine them.

Push registration is implemented behind an exact, fail-closed build opt-in.
Without that opt-in the app does not request notification permission or contact
Expo or the native provider, removes any earlier server endpoints when
authenticated, and explains that registration is disabled. Working code and
mock tests do not prove
physical-device delivery; current provider state lives only in
`docs/INTEGRATIONS.md`.
The native appearance stays light until the app has complete dark navigation,
screen, and system-bar colors; this prevents unreadable system controls when a
device itself uses dark mode.

## Local development

Use Bun 1.2.23 from the repository root:

```sh
bun install
bun run --cwd packages/mobile ios
bun run --cwd packages/mobile android
```

The platform commands generate and build the local native project as needed,
start Metro, and open the selected simulator or emulator. They do not send
notifications or connect provider credentials.

## Push registration configuration

Push registration uses one non-secret public build switch:

- `EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED`: only the exact value `true`
  allows permission checks and Expo token acquisition. Missing, malformed, or
  any other value fails closed.

The exact push-enabled build also requires `GOOGLE_SERVICES_JSON` as a
project-scoped, production-only EAS file variable with secret visibility.
`app.config.ts` passes that protected build-runner path to
`android.googleServicesFile`; it never copies the Firebase file into source.
Secret variables are deliberately unavailable when EAS resolves app config on
the operator's machine, and the iOS build does not consume the Android file.
The remote Android builder fails during app-config evaluation if registration
is enabled and the file is missing. Development and preview builds ignore that
provider file and retain registration disabled.

The EAS project UUID is pinned in `app.json`. Both values are public application
configuration and must never contain a token or credential. The `development`
and `preview` EAS profiles explicitly force the switch to `false`; only the
`production` profile sets it to `true`. Even that production value is not
authorization. The app submits its platform, application ID, semantic app
version, native build number, EAS project UUID, and embedded-only update mode,
and the server accepts registration only when the exact tuple appears in the
protected build allowlist documented in
[CONFIGURATION.md](../../docs/CONFIGURATION.md#expo-push-activation-boundary).
The allowlist separately authorizes provider and service environment; native
provider identity is never inferred from token text.

On every launch the app writes Expo's persisted automatic server-registration
state to the explicit non-null value `{ "isEnabled": false }`. Runtime code
deliberately avoids the `expo-notifications` package barrel because Expo 57
evaluates persisted auto-registration when that barrel loads. Token acquisition
instead obtains the native APNs/FCM token and performs one request to the fixed
Expo token endpoint only after build
opt-in, authenticated-online session, permission, native-build identity, and
native-token gates. That request has an eight-second deadline, is cancelled if
authenticated state is lost, and never re-enables Expo's independent
registration side path. Only a response matching Expo's strict push-token shape
is combined with the native `apns` or `fcm` token in one request to PSD EOC's
canonical device capability. The server authorizes, inserts, and rotates that
native/Expo pair in one transaction. A failure commits neither member of a new
pair and makes no claim that a first-time fallback exists; any previously
committed generation remains governed by its existing endpoint history.
Replacements and cleanup are scoped by provider so the two active endpoints
can coexist without overwriting each other.

Android creates `eoc-alerts` before permission/token work with maximum
importance, default sound, vibration, and public lock-screen visibility. iOS
declares the time-sensitive entitlement. If notification permission or the
Android alert channel is disabled, the app appends server unregistration truth,
shows platform-specific Settings instructions, and the stale-roster report
marks the recipient as having no active push endpoint.

Foreground notifications display only when the strict contracts payload and
both visible real/drill markers agree. Notification taps from running,
background, or terminated launches are deduplicated, retained through device
unlock, and routed only by the canonical event ID. Sign-out authenticates when
locked and requires successful server revocation/push cleanup before local
SecureStore state is removed; cleanup is never queued offline.

Server-side protected configuration chooses Expo or direct delivery separately
for iOS and Android. Changing that cutover does not change mobile code, rewrite
registration history, or cause a second copy to be sent. Development and
preview builds remain disabled; only an exact allowlisted privately distributed
build may dual-register.

Physical delivery remains a controlled external-integration run. The Expo
activation and direct-provider records are retained in the district's private
operations records; current state is in `docs/INTEGRATIONS.md`. APNs and FCM
credentials, exact
private builds, and the two physical-device drills require authenticated human
work. Never place push tokens, credentials, real recipients, or raw provider
payloads in evidence.

## Authentication configuration

Mobile authentication uses one non-secret public build value:

- `EXPO_PUBLIC_PSD_EOC_API_BASE_URL`: the PSD EOC server origin. Production
  and distributed builds require HTTPS; local development may use a loopback
  HTTP origin.

Configure this value in the local process environment or the matching EAS
environment. `EXPO_PUBLIC_` values are compiled into the app and are visible
to users, so the value must never contain a Google client secret, bearer token,
provider credential, or other secret. The server's native-auth start endpoint
returns the public client ID, fixed app redirect, state, and authorization URL;
none of those values are mobile build configuration. Missing or malformed API
configuration must fail closed at sign-in. Development and CI use the
synthetic loopback server and mocked OIDC provider; automated tests must never
call live Google endpoints.

The `psdeoc` app scheme returns the authorization-code + PKCE flow to the
native app. OAuth redirects and Face ID cannot be validated in Expo Go; use a
development build. SecureStore's device authentication behavior also requires
a real iOS or Android device for release evidence because simulator and
emulator behavior is not equivalent. Device passcode fallback is provided by
the operating system; PSD EOC does not define or store a custom PIN.

Run the mobile checks from the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/mobile lint
bun run --cwd packages/mobile typecheck
bun run --cwd packages/mobile test
bun run --cwd packages/mobile expo:check
bun run --cwd packages/mobile react:check
bun run --cwd packages/mobile prebuild:check
bun run check
```

`expo:check` wraps `expo install --check`. Expo publishes patch releases of
the SDK packages several times a month; a package that is only a patch behind
is reported and does not fail the check, while a major or minor mismatch does,
because that can diverge from the SDK's native code. Bump with
`bunx expo install --fix` and update the pinned set in
`scripts/distribution-config.test.ts`.

`prebuild:check` runs `expo prebuild --no-install`, then normalizes generated
iOS JSON so the repository format gate remains usable while native artifacts
exist. The generated `ios/` and `android/` directories are local sanity-check
artifacts and are ignored. The platform run commands prepare those artifacts
through the same path before compiling and launching the app.

## EAS build profiles

Run EAS commands from this directory because it is the Expo app root:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 build --platform all --profile preview
```

The profiles in `eas.json` are:

- `development`: internal development-client builds.
- `preview`: internal iOS and Android distribution builds.
- `production`: store-signed artifacts for TestFlight and Google Play.

Remote updates are disabled for app/runtime 1.0.16. No profile may check,
download, publish, or route an OTA update. JavaScript changes use a new app
version and store build until a separately scoped change provisions district-
held update signing, embeds its public certificate in a new runtime, and adds a
reviewed rollout and rollback procedure. Ordinary `preview` must never be used
for production-environment OTA verification.

All profiles pin Bun 1.2.23 and use credentials managed remotely by EAS.
Never add certificates, provisioning profiles, API keys, push keys,
`credentials.json`, `google-services.json`, or `GoogleService-Info.plist` to the
repository. EAS project linking and credential creation require an authorized
human account. Store submission and live push configuration are separate
production changes and require explicit product-owner approval.

The app config declares the development APNs entitlement emitted by prebuild.
Xcode signing replaces it with the provisioning profile's production value for
a release archive when appropriate. No EAS profile submits an artifact
automatically.

## Dependency rationale

Expo, React Native, React, Expo Router, and its navigation support packages are
the required managed-app runtime. `expo-dev-client` supports the development
profile, `expo-splash-screen` supplies the generated launch screen, and
`expo-system-ui` applies the configured platform color scheme.
`expo-notifications` supplies native notification configuration plus the local
Android channel API, permission state, token rotation events, and notification
response events through side-effect-free module entry points. None of these
dependencies enables a live send by itself.

`expo-auth-session` owns the native browser authorization-code + PKCE flow,
and its required `expo-crypto` peer generates the PKCE material without a
client secret. `expo-secure-store` encrypts the opaque PSD EOC session bearer
in platform storage and excludes its Android entries from unusable restored
backups. `expo-local-authentication` provides the operating-system Face ID,
Touch ID, Android biometric, and device-passcode prompt. Both native config
plugins use the same plain-language Face ID permission. `expo-web-browser` is
an AuthSession transitive dependency; the native app does not import it
directly.

`expo-image-picker` supplies consent-based library image selection without
camera or microphone access,
`expo-file-system` retains a private retryable photo draft through app
backgrounding, and `expo-location` supplies foreground-only coordinates with
their measured accuracy; none enables background collection or a live send.
Jest Expo and React Native Testing Library provide native accessibility and
interaction tests in addition to the Bun unit suite.

`react-dom` is pinned beside mobile React so Expo resolves a matched 19.2.3
runtime. The server uses the same exact React pair so Bun cannot make Next and
the mobile dependency graph load incompatible React copies. The mobile CI job
checks that mobile, Expo Router, the server, and Next all resolve the same
physical React and ReactDOM packages after a frozen install.
