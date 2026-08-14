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
   explicitly `drill`. On iOS, the runner injects the notification only after
   the independently authenticated protected shell is stable, then proves and
   opens the exact card through Notification Center, requires the same-request
   system action, and records the production `expo-notifications` listener and
   parser evidence. The iOS 26 protected router remains on the lobby after the
   overlay closes, so Maestro truthfully joins that same run-specific active
   drill through its ordinary lobby card, then the runner opens the app's
   registered read-only event URL and requires the exact room evidence. On
   Android, the retained routing card foregrounds the authenticated app after
   the separate unlock card. Both paths must reach the exact event room.
4. The user appends a synthetic text journal fact, reviews a fresh mocked
   all-clear consequence preview, types the required phrase, and explicitly
   taps the all-clear action. The event remains a drill and is not closed.

For the development-only synthetic activation journey, the runner patches only
its marker-owned copied issue-21 fixture with exact fanout-status and token-free
push-unregister responses. That compatibility seam proves the ordinary mobile
UI, authentication, and human confirmation flow; it does not prove production
server fanout or unregister behavior, provider acceptance, or delivery.

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
sign-in state before beginning loopback OIDC enrollment. Once that enrollment's
real LocalAuthentication split has committed the protected shell, the runner
injects the exact synthetic DRILL card locally while the app remains
foregrounded. It allows the transient foreground banner a bounded eight
seconds to settle without touching it, then an app-scoped top-edge Maestro
gesture opens Notification Center without adding another authentication or
app-lifecycle transition; the later card gestures are SpringBoard-scoped.
Because iOS 26 exposes the underlying app hierarchy through this overlay, a fresh
simulator screenshot is analyzed locally with Apple's Vision framework before
any notification gesture: exactly one complete DRILL title/body must be
recognized with high confidence, INCIDENT text must be absent, and the swipe
origin is derived from and must remain inside that exact body.

If the guarded right swipe executes `Open`, its same-request SpringBoard
transaction is required; otherwise a fresh Vision analysis must bind the
uniformly shifted visible DRILL title/body crop back to the original card and
prove one adjacent exact `Open` label before its one non-retrying tap. No
unverified coordinate tap is accepted. A passive E2E-only observer records the
native response shape and whether the production parser accepts it, but it
cannot navigate or clear response evidence. The production listener is
exercised with that exact action and payload, while a following Maestro step
joins the same run-specific active drill through its ordinary lobby card. The
runner then opens the registered `psdeoc` event URL, proves and accepts only the
exact iOS `Open in “PSD EOC”?` system prompt, and admits navigation only when
the exact route evidence appears. The suite does not mislabel either transition
as notification routing. The runner also requires SpringBoard to record exactly one
`UNNotificationDefaultActionIdentifier` execution and removal for the same
request after either path. Notification disappearance alone is never pass
evidence. The runner deletes that exact simulator during cleanup;
physical-device system-lock behavior remains separate release evidence and is
not claimed here.

```sh
export PSD_EOC_E2E_SYNTHETIC_ONLY=true
export TEST_DATABASE_URL='postgresql://psd_eoc_test:synthetic_test_password@127.0.0.1:54329/psd_eoc_mobile_ios_test'
export PSD_EOC_MOBILE_E2E_ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/psd-eoc-mobile-e2e-artifacts.XXXXXX")"
bun packages/mobile/e2e/run-ci.ts ios
```

To pause an otherwise normal local run after the verified notification action
and ordinary exact-drill card have opened the authenticated synthetic event
room, set
`PSD_EOC_MOBILE_E2E_SCREENSHOT_HOLD_SECONDS` to an integer from 1 through 600.
The runner writes `operator-screenshot-ready.txt` in the platform artifact and
holds that screen for the requested interval before continuing the lifecycle
journey. Creating a regular `operator-screenshot-done.txt` file in that same
artifact releases the hold early. CI does not set this option.

For Android, start one x86_64 API 36 Google APIs emulator, export its serial as
`ANDROID_SERIAL`, and ensure the SDK and Java 17 are configured. The hosted
suite deliberately builds only x86_64 native code; an arm64 emulator is not a
supported local target for this runner. The runner
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
