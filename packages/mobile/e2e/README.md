# Mobile end-to-end evidence (issue #32)

This directory owns the synthetic-only Maestro evidence for PSD EOC's mobile
critical journeys. The runner builds a development client in an isolated
temporary copy of `packages/mobile`; generated `ios/`, `android/`, Metro, and
native build files never touch the checkout.

A successful suite run proves these foreground user journeys on both
platforms:

1. A staff user's enrolled issue-21 fixture invokes the ordinary foreground
   device-authentication gate and starts one synthetic drill in the three
   documented activation taps. The fixture has only synthetic recipients and
   records mocked notification intents without provider I/O.
2. A fresh normal app signs in through the issue-32 loopback OIDC provider,
   establishes an enrolled local session, and loads the canonical active
   synthetic drill from an isolated PostgreSQL test database.
3. A provider-free platform notification is presented through the installed
   app's platform integration. The visible alert and versioned data are both
   explicitly `drill`; tapping the system notification routes through the
   production `expo-notifications` response path to the exact event room.
4. The user appends a synthetic text journal fact, reviews a fresh mocked
   all-clear consequence preview, types the required phrase, and explicitly
   taps the all-clear action. The event remains a drill and is not closed.

No flow starts a real incident, sends a real notification, closes an event,
contacts Google, or uses a provider token. The server runtime refuses anything
except `PSD_EOC_E2E_SYNTHETIC_ONLY=true` and a loopback PostgreSQL database
whose name ends in `_test`. Push registration is disabled in the normal Metro
bundle. Both notification injectors are local transport substitutes only:

- iOS uses `xcrun simctl push` with an APNs simulator payload. Canonical
  response fields are in the top-level `body` object because that is the shape
  exposed as `notification.request.content.data` by Expo on iOS.
- Android instrumentation calls the installed Expo Notifications
  `FirebaseMessagingDelegate` with an in-memory, data-only `RemoteMessage` and
  then verifies the resulting app-owned system notification. It never obtains
  an FCM or Expo token.

## Run locally

Install the repository with its pinned Bun version first:

```sh
bun install --frozen-lockfile
```

Both platforms require Maestro 2.7.0 on `PATH` and Java 17. Use only a local
PostgreSQL test database containing no real recipient or student data. The
runner creates and later removes only its marker-owned temporary workspace;
Maestro reports and platform diagnostics remain in a fresh requested artifact
directory. Use a new artifact base for each local invocation.

For iOS, install Xcode with an available iOS Simulator runtime, CocoaPods, and
CMake. The runner creates a dedicated simulator, enrolls simulated biometrics,
explicitly locks it before provider-free notification injection, and proves
the exact DRILL card appeared in the lock-screen hierarchy. It uses Maestro's
bottom-edge swipe to dismiss the simulator lock, opens Notification Center,
and taps that same exact synthetic card. Maestro's pinned `applesimutils`
answers only the app's genuine LocalAuthentication request. The runner deletes
that exact simulator during cleanup; physical-device system-lock behavior
remains separate release evidence and is not claimed here.

```sh
export PSD_EOC_E2E_SYNTHETIC_ONLY=true
export TEST_DATABASE_URL='postgresql://psd_eoc_test@127.0.0.1:54329/psd_eoc_mobile_ios_test'
export PSD_EOC_MOBILE_E2E_ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/psd-eoc-mobile-e2e-artifacts.XXXXXX")"
bun packages/mobile/e2e/run-ci.ts ios
```

For Android, start one API 36 Google APIs emulator, export its serial as
`ANDROID_SERIAL`, and ensure the SDK and Java 17 are configured. The runner
sets a synthetic emulator-only device credential, reverses only its loopback
ports, and invokes the issue-owned instrumentation source through the generated
Expo Gradle project.

```sh
export PSD_EOC_E2E_SYNTHETIC_ONLY=true
export TEST_DATABASE_URL='postgresql://psd_eoc_test@127.0.0.1:54329/psd_eoc_mobile_android_test'
export PSD_EOC_MOBILE_E2E_ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/psd-eoc-mobile-e2e-artifacts.XXXXXX")"
export ANDROID_SERIAL='emulator-5554'
bun packages/mobile/e2e/run-ci.ts android
```

`DATABASE_URL` is intentionally ignored by the harness; the isolated server is
derived only from `TEST_DATABASE_URL`. Do not point either command at a shared,
staging, or production database. A missing tool, unavailable runtime, changed
native dependency, malformed manifest, non-loopback origin, blocked first-run
development-client onboarding, absent device-auth prompt, or skipped
notification causes a failure rather than a partial pass.

## CI and evidence

`.github/workflows/mobile-e2e.yml` runs for pull requests into `main`, pushes
to `main`, and explicit manual dispatches. Its iOS and Android jobs provision
isolated PostgreSQL databases, install the pinned Maestro archive after
checking its SHA-256 digest, and upload the runner's evidence even after
failure. Pull-request execution makes the native evidence available before an
issue is merged; the push trigger keeps the required `main` branch regression
evidence current.

Each successful platform artifact includes:

- a redacted, `planned` safety manifest binding the run to `drill`,
  `synthetic`, and `mocked` integration truth;
- server, Metro, native-build, instrumentation, and Maestro logs;
- the exact machine-checked Android SystemUI hierarchy or reviewable iOS system
  hierarchy and screenshot preserved at each device-authentication split, plus
  a required authenticated post-state Maestro flow; iOS also preserves the
  simulator biometric-response command result, while Android never logs its
  synthetic emulator PIN input;
- JUnit reports plus Maestro screenshots and command traces;
- platform diagnostics and an exact `complete.txt` pass summary, written only
  after every planned journey and cleanup succeeds.

Screenshots can contain synthetic event identifiers and synthetic fixture
copy. They must never contain credentials, real recipients, or student data.
The simulator/emulator suites are regression evidence; release-device
credential and push-provider verification remains a separately authorized
production-readiness activity and is not claimed here.
