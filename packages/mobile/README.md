# PSD EOC mobile

The PSD EOC native client is an Expo SDK 57 managed app for iOS and Android.
Expo Router owns navigation. Shared domain types come from
`@psd-eoc/contracts`; mobile code must not redefine them.

This scaffold does not register a push token, request notification permission,
or contact a notification provider. It only creates the local Android alert
channel. Expo Push remains `mocked`, as recorded in `docs/INTEGRATIONS.md`.
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
Android channel API. None of these dependencies enables a live send by itself.

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
