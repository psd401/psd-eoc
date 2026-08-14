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
   app's platform integration. Its visible alert and versioned payload are
   explicitly `drill`. The exact card remains pending while device
   authentication completes; after the protected navigator is stable, tapping
   that same notification routes through the production `expo-notifications`
   response path to the exact event room.
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
  then verifies the resulting app-owned system notifications. Its DRILL-marked
  unlock card deliberately omits the canonical routing envelope and is rejected
  by the production response parser; only the retained route card carries the
  valid synthetic drill payload. It never obtains an FCM or Expo token.

## Run locally

Install the repository with its pinned Bun version first:

```sh
bun install --frozen-lockfile
```

Both platforms require Java 17. Install the exact Maestro archive used by CI;
the checksum gate prevents a changed download from silently becoming test
evidence:

```sh
export PSD_EOC_MAESTRO_VERSION='2.7.0'
export PSD_EOC_MAESTRO_SHA256='a4ccab6b604617e7aef6db4f885666056eabe5cfa32befaa3bc994041b8fcbb5'
export PSD_EOC_MAESTRO_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/psd-eoc-maestro.XXXXXX")"
export PSD_EOC_MAESTRO_ARCHIVE="$PSD_EOC_MAESTRO_ROOT/maestro.zip"
curl --fail --location --retry 3 --retry-all-errors \
  --output "$PSD_EOC_MAESTRO_ARCHIVE" \
  "https://github.com/mobile-dev-inc/maestro/releases/download/cli-$PSD_EOC_MAESTRO_VERSION/maestro.zip"
if command -v shasum >/dev/null 2>&1; then
  printf '%s  %s\n' "$PSD_EOC_MAESTRO_SHA256" "$PSD_EOC_MAESTRO_ARCHIVE" \
    | shasum -a 256 --check
else
  printf '%s  %s\n' "$PSD_EOC_MAESTRO_SHA256" "$PSD_EOC_MAESTRO_ARCHIVE" \
    | sha256sum --check
fi
unzip -q "$PSD_EOC_MAESTRO_ARCHIVE" -d "$PSD_EOC_MAESTRO_ROOT"
export PATH="$PSD_EOC_MAESTRO_ROOT/maestro/bin:$PATH"
test "$(maestro --version | tail -n 1 | tr -d '\r')" = "$PSD_EOC_MAESTRO_VERSION"
```

Provision one loopback-only PostgreSQL 16 database for the platform being run.
The following clean-machine option uses Docker and exactly the synthetic role,
port, and database expected by the examples below. Set the database name to
`psd_eoc_mobile_android_test` for Android.

```sh
export PSD_EOC_LOCAL_DATABASE='psd_eoc_mobile_ios_test'
docker run --rm --detach \
  --name psd-eoc-mobile-e2e-postgres \
  --publish 127.0.0.1:54329:5432 \
  --env POSTGRES_DB="$PSD_EOC_LOCAL_DATABASE" \
  --env POSTGRES_USER='psd_eoc_test' \
  --env POSTGRES_PASSWORD='synthetic_test_password' \
  postgres:16-alpine
until docker exec psd-eoc-mobile-e2e-postgres \
  pg_isready --username psd_eoc_test --dbname "$PSD_EOC_LOCAL_DATABASE"; do
  sleep 1
done
export TEST_DATABASE_URL="postgresql://psd_eoc_test:synthetic_test_password@127.0.0.1:54329/$PSD_EOC_LOCAL_DATABASE"
```

On macOS, if Homebrew PostgreSQL 16 is already installed locally, this is the
equivalent container-free provisioning. It creates both platform databases so
the same server can be reused for consecutive iOS and Android runs:

```sh
export PSD_EOC_POSTGRES_BIN="$(brew --prefix postgresql@16)/bin"
export PSD_EOC_POSTGRES_DATA="$(mktemp -d "${TMPDIR:-/tmp}/psd-eoc-postgres.XXXXXX")"
"$PSD_EOC_POSTGRES_BIN/initdb" \
  --pgdata "$PSD_EOC_POSTGRES_DATA" \
  --username psd_eoc_test \
  --auth trust \
  --encoding UTF8 \
  --no-locale
"$PSD_EOC_POSTGRES_BIN/pg_ctl" \
  --pgdata "$PSD_EOC_POSTGRES_DATA" \
  --log "$PSD_EOC_POSTGRES_DATA.log" \
  --options '-h 127.0.0.1 -p 54329' \
  start
"$PSD_EOC_POSTGRES_BIN/createdb" --host 127.0.0.1 --port 54329 \
  --username psd_eoc_test psd_eoc_mobile_ios_test
"$PSD_EOC_POSTGRES_BIN/createdb" --host 127.0.0.1 --port 54329 \
  --username psd_eoc_test psd_eoc_mobile_android_test
```

Use only these local test databases containing no real recipient or student
data. The runner creates and later removes only its marker-owned temporary
workspace; Maestro reports and platform diagnostics remain in a fresh
requested artifact directory. Use a new artifact base for each invocation.
Afterward, stop the Docker container with
`docker stop psd-eoc-mobile-e2e-postgres`, or stop the native server with
`"$PSD_EOC_POSTGRES_BIN/pg_ctl" --pgdata "$PSD_EOC_POSTGRES_DATA" --mode fast stop`.

For iOS, install Xcode with an available iOS Simulator runtime, CocoaPods, and
CMake. The runner creates a dedicated simulator, enrolls simulated biometrics,
uses Xcode's native keychain reset between fixture activation and the fresh
normal-app enrollment while preserving that biometric enrollment. If the
production cleanup-first vault recovery requests authentication after reset,
the runner answers that genuine system prompt and requires a stable fresh
sign-in state before beginning loopback OIDC enrollment. It then
explicitly locks it before provider-free notification injection, and proves
the exact DRILL card appeared in the lock-screen hierarchy. It then answers
the dedicated simulator's system-lock Face ID challenge, resumes the
still-mounted app into its independent LocalAuthentication challenge, answers
that challenge, and requires Maestro to prove the protected shell is stable.
Only then does it open Notification Center and tap that same pending synthetic
card. If iOS 26 leaves the card
on the Cover Sheet (including after expanding a first-run notification stack),
the runner waits a bounded first-response window, then requires three stable
samples with exactly one complete DRILL card, bounds disjoint from every other
notification, and no INCIDENT text. It performs one exact-card right swipe and
then measures three more stable hierarchies. Only an unchanged card with a
newly exposed leading strip at least 44 points wide admits one non-retrying
Open tap at that measured strip's midpoint. The runner then requires
SpringBoard to record exactly one `UNNotificationDefaultActionIdentifier`
execution and removal for that same request after the tap. Notification
disappearance alone is never pass evidence. The production response listener
must then reach the run-specific route evidence in the exact synthetic drill
room. This preserves one notification across lock and app authentication while
avoiding an auth-driven route-tree transition during response handling. The
runner deletes that exact simulator during cleanup;
physical-device system-lock behavior remains separate release evidence and is
not claimed here.

```sh
export PSD_EOC_E2E_SYNTHETIC_ONLY=true
export TEST_DATABASE_URL='postgresql://psd_eoc_test:synthetic_test_password@127.0.0.1:54329/psd_eoc_mobile_ios_test'
export PSD_EOC_MOBILE_E2E_ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/psd-eoc-mobile-e2e-artifacts.XXXXXX")"
bun packages/mobile/e2e/run-ci.ts ios
```

To pause an otherwise normal local run after the exact notification route has
opened the authenticated synthetic drill event room, set
`PSD_EOC_MOBILE_E2E_SCREENSHOT_HOLD_SECONDS` to an integer from 1 through 600.
The runner writes `operator-screenshot-ready.txt` in the platform artifact and
holds that screen for the requested interval before continuing the lifecycle
journey. Creating a regular `operator-screenshot-done.txt` file in that same
artifact releases the hold early. CI does not set this option.

For Android, start one API 36 Google APIs emulator, export its serial as
`ANDROID_SERIAL`, and ensure the SDK and Java 17 are configured. The runner
sets a synthetic emulator-only device credential, reverses only its loopback
ports, force-stops the app and verifies it has no resumed activity, then invokes
the issue-owned instrumentation source through the generated Expo Gradle
project. The instrumentation runs the installed Expo delegate without
foregrounding an activity; the runner verifies that background state again
before opening the exact system notification.

```sh
export PSD_EOC_E2E_SYNTHETIC_ONLY=true
export TEST_DATABASE_URL='postgresql://psd_eoc_test:synthetic_test_password@127.0.0.1:54329/psd_eoc_mobile_android_test'
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
