# PSD EOC mobile

The PSD EOC native client is an Expo SDK 57 managed app for iOS and Android.
Expo Router owns navigation. Shared domain types come from
`@psd-eoc/contracts`; mobile code must not redefine them.

This scaffold does not register a push token, request notification permission,
or contact a notification provider. It only creates the local Android alert
channel. Expo Push remains `mocked`, as recorded in `docs/INTEGRATIONS.md`.

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

Run the mobile checks from the repository root:

```sh
bun run --cwd packages/mobile lint
bun run --cwd packages/mobile typecheck
bun run --cwd packages/mobile test
bun run --cwd packages/mobile expo:check
bun run --cwd packages/mobile prebuild:check
```

`prebuild:check` runs `expo prebuild --no-install`. The generated `ios/` and
`android/` directories are local sanity-check artifacts and are ignored.

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
