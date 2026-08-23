# Issue 32 mobile E2E

This suite builds a development client and runs the same synthetic journey on
iOS and Android:

1. unlock the process-local synthetic staff session;
2. start the three-tap `DRILL — TRAINING ONLY` fixture;
3. receive a delayed local OS notification carrying the canonical drill route;
4. tap the notification, unlock again, and open that exact event;
5. post `Synthetic mobile issue 32 update.`; and
6. review mocked consequences, type `ALL CLEAR`, and issue the synthetic
   all-clear.

The notification is a provider-free push mock. It uses Expo's installed local
notification scheduler and the production notification-response router, but it
never gets a token, contacts Expo/APNs/FCM, or opens a provider connection. The
operational transport is in memory, accepts only the exact synthetic drill,
labels every channel `mocked`, and rejects real, staff-roster, and unexpected
requests.

The runner reads the iOS bundle identifier, Android application ID, and URL
scheme from `app.json`; no Maestro flow contains a tenant app ID. It refuses to
start unless all five safety variables have their exact values.

## Run locally

Install Bun dependencies, Maestro 2.7.0, Xcode with an iPhone simulator, and/or
the Android SDK with a running emulator. Then run one platform:

```bash
export PSD_EOC_E2E_SYNTHETIC_ONLY=true
export EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE=issue-21
export EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE=issue-32
export EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE=issue-32
export EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED=false
bun packages/mobile/e2e/run.ts ios
bun packages/mobile/e2e/run.ts android
```

Set `PSD_EOC_IOS_UDID` or `ANDROID_SERIAL` to select a simulator. Without one,
the runner chooses an available iPhone simulator or running Android emulator.
For Android, it resolves the selected serial to the AVD name that Expo requires
and uses that same emulator for the build, ADB, and Maestro. The runner creates
ignored native prebuild directories, uses an exact-flag synthetic simulator
authenticator, grants notification permission, and saves JUnit, Maestro debug
output, a notification screenshot, and an all-clear screenshot under
`.verification/issue-32/mobile-<platform>`. Set
`PSD_EOC_MOBILE_E2E_ARTIFACT_DIR` to use another artifact directory.

Run the fast harness checks without a simulator:

```bash
bun run test:e2e:mobile:verify
```

The dedicated `Mobile E2E` workflow runs both platforms after every push to
`main` and supports manual dispatch once the workflow exists on the default
branch. Before merge, a maintainer can apply the `mobile-e2e` pull-request
label to opt into both native jobs; later commits rerun them while the label
remains applied. Pull requests run the web Playwright and axe journeys in the
ordinary CI workflow.
