# Android provider-free push injection

This issue #32 harness proves Android notification presentation without an
FCM/Expo send. It builds an Android instrumentation test into Expo's generated
app, runs inside `net.psd401.eoc`, constructs one canonical version-1
synthetic `drill`/`drill`/`activation` payload, and calls the installed
`expo-notifications` `FirebaseMessagingDelegate` directly.

The harness never requests a token and contains no provider or network client.
It fails closed unless the runner supplies a fresh synthetic run proof and the
server-owned E2E manifest independently proves that all three UUIDs belong to
that run's synthetic event. It cannot establish database provenance by itself.

## Preconditions

- Run `bun install` at the repository root.
- Generate `packages/mobile/android` with Expo SDK 57. The init script pins the
  reviewed native versions and stops on version drift.
- Install and launch the debug app once so its production startup creates the
  `eoc-alerts` channel.
- Grant `POST_NOTIFICATIONS` to the debug app on Android 13 or newer.
- Keep the app out of the foreground while instrumentation runs so Expo's
  background receive path presents the data-only message.

## Run on a connected emulator

From `packages/mobile`:

```sh
bun x expo prebuild --platform android --no-install
adb shell pm grant net.psd401.eoc android.permission.POST_NOTIFICATIONS
./android/gradlew \
  -p android \
  --init-script e2e/android/issue-32.init.gradle \
  :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.runId=0123456789abcdef0123456789abcdef \
  -Pandroid.testInstrumentationRunnerArguments.responseId=issue-32-0123456789abcdef0123456789abcdef \
  -Pandroid.testInstrumentationRunnerArguments.eventId=00000000-0000-4000-8000-000000003201 \
  -Pandroid.testInstrumentationRunnerArguments.eventKind=drill \
  -Pandroid.testInstrumentationRunnerArguments.templateMode=drill \
  -Pandroid.testInstrumentationRunnerArguments.facilityId=00000000-0000-4000-8000-000000000001 \
  -Pandroid.testInstrumentationRunnerArguments.eventTypeVersionId=00000000-0000-4000-8000-000000000201 \
  -Pandroid.testInstrumentationRunnerArguments.purpose=activation
```

The literal values above demonstrate the invocation shape; CI must replace the
run ID, response ID, and event ID with the values from its current synthetic
manifest. The facility and event-type version IDs must also match that manifest.
The runner must reject a manifest that is not synthetic before invoking Gradle.

On success, the system tray retains one app-owned notification tagged exactly
`issue-32-<runId>` on `eoc-alerts`. Maestro can tap that notification next. The
instrumentation also proves that the notification's `contentIntent` is owned by
the installed PSD EOC application UID and launches an activity.

Run the static safety checks from the repository root:

```sh
bun test packages/mobile/e2e/android/injector.test.ts
```

The two AndroidX artifacts added by the init script are instrumentation-only
test dependencies; they are not packaged in PSD EOC's production runtime.
