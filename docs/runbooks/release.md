# Mobile release and rollback runbook

This runbook governs private PSD EOC mobile distribution. It does not authorize
a production deployment, a public store release, a real incident, a real
notification, an all-clear, or closing a real event. No build, upload, tester
exposure, or provider mutation runs from CI or a schedule. Every write requires
a fresh exact consequence preview, explicit product-owner approval, and fresh
confirmation by the authorized human operator. Stop when an identity,
credential, target, build, consequence, approval, or provider result is
missing, stale, or ambiguous.

Release 1 targets are fixed:

- iOS: `net.psd401.eoc`. The first install proof uses the private TestFlight
  internal group `District Technology`. Any later ordinary-staff cohort uses
  only the external group `Staff` after its separate Beta App Review gates.
- Android: `net.psd401.eoc`. The bounded first-install path is Play **Internal
  testing** with at most 100 approved testers. Play **Closed testing — Alpha**
  (`alpha`) remains the durable staff path; later EAS submissions target that
  track and remain unreleased drafts until a human separately reviews them.
- Current app/runtime 1.0.4 uses only code and assets embedded in its store binary.
  Remote updates are disabled and no EAS update channel is attached.
- No build is promoted to an App Store public release or Play `beta` or
  `production` track by this runbook.

Read [App Store Connect and TestFlight setup](appstore-setup.md) before any
Apple operation. Staff installation steps live in
[the iOS guide](../guides/install-ios.md) and
[the Android guide](../guides/install-android.md).

## 1. Release record and progressive gates

Create one private, append-only operational record. Append the preview, exact
approval, fresh human confirmation, provider result, and independent read-back
for each gate. Correct mistakes with a superseding entry; never rewrite or
delete history. The record must contain no credential, token, private key,
tester address, recipient export, student data, device identifier, or raw
provider response.

Record:

- release owner and human operator roles;
- product-owner approval reference, exact scope, and time;
- exact clean Git commit SHA and the reviewed diff;
- `expo.version`, runtime policy, remote-update state, and Expo package set;
- exact EAS build IDs, platform, profile, application identifier, resolved
  native build number, source commit, status, and artifact SHA-256;
- exact App Store Connect build ID or Play release/version-code identity;
- fixed TestFlight group or Play track plus the approved tester-list digest and
  count, never tester identities;
- consequence-preview digest, provider outcome, and non-sensitive evidence
  links;
- the exact known-good store build or the explicit fact that none exists;
- the installed diagnostic read-back described in section 4.

A downstream identifier that does not exist is recorded as
`PENDING — not created yet`. Never invent it. These conditions apply to every
gate:

- [ ] Credentials are verified, least privilege, and stored outside every Git
      repository in an approved secrets system.
- [ ] `bun install --frozen-lockfile` and `bun run check` pass on the exact
      release commit.
- [ ] `bun run --cwd packages/mobile expo:check`, the distribution
      configuration test, and the native prebuild check pass on that commit.
- [ ] No student or guardian data, unknown tester, real recipient export, or
      real-incident activation is used as release evidence.
- [ ] Any partial, conflicting, stale, or indeterminate result stops the gate
      and is appended as `unknown`.

Approval for one gate never authorizes another.

### BUILD

BUILD creates an immutable EAS artifact. It does not submit, invite, expose,
publish an update, sign in on a device, register a push token, or authorize a
PSD EOC notification. Its preview binds:

- exact clean Git SHA and reviewed diff;
- platform and `production` profile;
- `net.psd401.eoc`, app/runtime 1.0.4, and embedded-only update policy;
- the exact public API origin and compiled push-registration switch;
- existing remote signing-credential identity;
- current remote native-version counter and exact predicted transition;
- quota/cost consequence.

Before BUILD:

- [ ] Read-only EAS environment evidence shows exactly one project-scope
      plaintext string `EXPO_PUBLIC_PSD_EOC_API_BASE_URL` with exact value
      `https://eoc.psd401.net`, and no account-scope value with that name.
- [ ] It also shows exactly one project-scope plaintext string
      `EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED` with exact value `true`,
      and no account-scope value with that name. This makes an installed,
      authenticated binary capable of registration; BUILD approval alone does
      not authorize installation, sign-in, registration, provider testing, or
      any notification.
- [ ] Resolved production config for both platforms contains those values,
      app/runtime 1.0.4, remote updates disabled, automatic checks set to
      `NEVER`, no update URL, and no EAS channel.
- [ ] Required remote signing credentials already exist and are read back.
      BUILD must stop instead of creating, selecting, repairing, or refreshing
      credentials. EAS CLI 21.7.0 does not reliably apply
      `--freeze-credentials` while setting up a missing Android keystore, so an
      absent or indeterminate default remote keystore blocks BUILD.
- [ ] The preview states the exact version-counter transition and cost. No
      existing number may be decremented or reused.
- [ ] The source revision has no provider key, certificate private key,
      `credentials.json`, real tester list, or recipient data.

After BUILD—even after refusal, interruption, or partial failure—reread the
remote counter, credential identity, build records, and quota/cost state.
Append the immutable EAS build ID, resolved number, source-upload/build-job
status, artifact digest, and every consumed number. Never blindly retry.

Issue #37's first manual AAB upload and issue #40's separately authorized
physical-push work may consume an eligible BUILD artifact; completion of those
issues is not a BUILD prerequisite.

### SUBMIT

SUBMIT binds one exact finished EAS build ID and digest to one verified
provider app record.

- [ ] iOS has the reviewed numeric `ascAppId`, complete TestFlight inventory,
      and automatic group distribution disabled.
- [ ] Android's first release is a manual Play Console upload of the exact
      eligible AAB. Later EAS Submit requires completed first-upload and a
      release-scoped service account.
- [ ] The preview is upload-only. Play remains an unreleased `alpha` draft;
      neither platform sends invitations or makes a build installable.

Append provider identity, processing state, warnings, and read-back. Provider
acceptance is not tester exposure or human installation.

### TESTER EXPOSURE

TESTER EXPOSURE binds one processed provider build to the fixed
`District Technology` TestFlight group or Play `alpha` group. It also binds the
approved staff-only tester-list digest and count, invitation/installability
consequences, and the withdrawal or fix-forward target.

- [ ] The audience is named, bounded, product-owner approved, staff-only, and
      contains no student, guardian, real recipient export, or unknown member.
- [ ] Apple build/group assignment or invitation and Play draft completion are
      separately previewed, approved, freshly confirmed, and read back.
- [ ] Immediately before exposure, the provider build identity and artifact
      digest still match the release record.
- [ ] On the physical device, section 4 reports the exact embedded-only
      identity. Provider inventory alone is not device-adoption proof.
- [ ] Tester exposure authorizes installation only. It does not authorize a
      PSD EOC notification, a real incident, an all-clear, closing an event, or
      ordinary-staff expansion.

Before installation or sign-in, separately review the push-registration
consequence. An authenticated online session with already granted notification
permission can acquire a native token, contact Expo for an Expo token, and
register it with PSD EOC. Keep registration disabled outside a bounded,
approved synthetic staff-context verification. Any controlled synthetic push
is a separate issue #40 action requiring verified credentials, an approved
synthetic target list, a consequence preview, explicit product-owner
authorization, and authenticated-human confirmation. Never use a real
incident or live staff notification as release evidence.

### FINAL ACCEPTANCE

FINAL ACCEPTANCE is a read-only human evidence decision, not a provider-write
authorization. It requires:

- exact physical TestFlight and Play install identities;
- section 4's known embedded-only read-back for each physical install;
- a non-engineer walkthrough of both committed install guides;
- durable Play bootstrap evidence from issue #37;
- integration truth labels that claim only what is proven; and
- explicit product-owner sign-off for the completed checklist.

An old approval, credential, passing mock, successful build, upload, provider
processing result, or agent statement is not final acceptance. This record does
not authorize go-live, production deployment, ordinary-staff expansion, or any
of the four human-only critical actions.

## 2. Current release security boundary

> **Installed on devices.** The product owner attests on 2026-08-23 that PSD EOC
> is installed and running on a physical iPhone and a physical Android device.
> That is further than anything below records: the last iOS upload this runbook
> knows about failed Apple processing, and the Android release it knows about was
> an unexposed draft. Whoever next touches a store operation should read the
> installed build numbers off the devices and record them here and in
> `docs/INTEGRATIONS.md`, so the runbook stops trailing reality.

The current repository candidate is app/runtime 1.0.4. It preserves the
embedded-only boundary while adding the truthful Apple motion-framework purpose
string required to replace the failed iOS 1.0.1/build-2 upload. The already
built Android 1.0.1/code-3 artifact remains the exact eligible saved Play
Internal-testing draft. The committed 1.0.4 configuration must remain exactly:

- `updates.enabled: false`;
- `updates.checkAutomatically: "NEVER"`;
- `updates.useEmbeddedUpdate: true`;
- `updates.disableAntiBrickingMeasures: false`;
- no update URL;
- no `channel` in any EAS build profile; and
- no OTA-verification build profile.

Expo SDK 57's current compatible patch set includes `expo-updates` 57.0.17.
That patch rejects unsafe asset paths. The earlier Android v1.0.0 artifact has
57.0.13, unsigned on-load remote-update configuration, and cannot be changed
after build. It remains append-only evidence but is **SUPERSEDED — NOT ELIGIBLE
FOR PLAY UPLOAD, TESTER EXPOSURE, OR INSTALLATION**:

- EAS build: `856e54b5-9abd-45a5-b0db-809a295da5ef`
- source: `577cd741f90c553043374f6df9b7a3cac64f1336`
- version name/code: `1.0.0` / `2`
- AAB SHA-256:
  `015911fa614ba7b264f71a5f3186ab9c86940f94b98d77861b2864a761506463`

No Play upload, OTA publication, or physical installation of that artifact is
verified. Superseding it is preventive, not evidence of a live incident.

The one approved replacement Android BUILD completed and was independently
read back on 2026-08-14:

- EAS build: `3742b81d-3942-4fea-b760-53c809d8733f`
- source: `71e08fa8358f6890e5419289b163aaa0fb0af081`
- EAS status/profile: `FINISHED` / `production` store distribution
- application/runtime version: `1.0.1` / `1.0.1`
- version code: `3`; the remote counter read back `2` before and `3` after
- downloaded AAB size: `75,885,084` bytes
- AAB SHA-256:
  `915247b2a3c4c7eb97d685dd04e8886cf93f6caed24d605ac9991166faa64246`
- build-credential configuration: `V0WhYOyuIx` (default); signing-certificate
  SHA-256 fingerprint
  `6F:BE:1D:D8:4C:85:B1:FB:AC:DD:39:92:57:D4:8C:4C:05:29:61:67:16:BF:24:85:5D:42:97:16:02:98:C4:C9`
- EAS usage changed from 4/30 total and 3/15 Android before the sole build to
  5/30 total and 4/15 Android afterward; current estimated total cost is `$0`

The private downloaded Android copy passed ZIP integrity verification. Its
signing block verified and its certificate matched the reviewed
default-keystore fingerprint above. Embedded `app.config` proves package
`net.psd401.eoc`, app/runtime 1.0.1, disabled/`NEVER` updates, the
embedded-update fallback, and no update URL; the embedded bundle contains the approved
`https://eoc.psd401.net` API origin. Under a separate approved write, this exact
AAB was saved as artifact `4860219896995172827` in Play Internal testing draft
release 1. Play App Signing is active and the upload-key fingerprint matched.
The operator stopped before **Next**: no tester list, join link, preview,
confirmation, rollout, exposure, or physical-device installation exists.

Before the iOS BUILD, a separate provider-configuration gate was previewed,
explicitly approved by the product owner for one exact write, confirmed by the
authenticated human operator, and independently read back. It enabled only
Time Sensitive Notifications for Apple Team `87DL7L9GU6` and bundle
`net.psd401.eoc`, then regenerated in place existing App Store profile
`U8P2YKU4T8` and existing Ad Hoc profile `525SSPSUMQ` with unchanged profile
types, existing certificate serial `6C578391C0F8BD2C1E2E570FED205DED`, and an
unchanged Ad Hoc device set. It created no certificate, profile, key, or device
and authorized no BUILD, upload, submission, exposure, or installation. This
repository records only the bounded, non-secret read-back; the approval
transcript, credential material, and Apple session data remain outside the
repository and are not reusable authorization. BUILD began only after its
read-back matched and a later exact one-build preview received its own
product-owner approval.

The one approved iOS BUILD then completed and was independently read back on
2026-08-14:

- EAS build: `e68d07aa-98e5-4c87-8595-52175975291f`
- source: `bef4d64b40508dd3ef60e4de190a53b23effce40`
- EAS status/profile/distribution: `FINISHED` / `production` / `STORE`
- bundle ID: `net.psd401.eoc`
- application/runtime version: `1.0.1` / `1.0.1`
- build number: `2`; the remote counter read back `1` before and `2` after
- IPA SHA-256:
  `7c22776b959bb8f015f077b8fc73247b005b298ae97e18240d50aea77432adb9`
- existing distribution certificate serial:
  `6C578391C0F8BD2C1E2E570FED205DED`
- App Store provisioning profile: `U8P2YKU4T8`; SHA-256
  `c13a2847c944d0b0f25ba007ca06142c8218d87232ad9d36d1c86726355c1fde`
- EAS usage changed from 5/30 total and 1/15 iOS before the sole build to 6/30
  total and 2/15 iOS afterward; current estimated total cost is `$0`

The private downloaded IPA passed ZIP integrity verification. Its embedded
configuration proves app/runtime 1.0.1, disabled/`NEVER` updates, no update URL
or channel, the approved `https://eoc.psd401.net` API origin, and push
registration enabled. Its signed entitlements include the reviewed Time
Sensitive Notifications entitlement; no other capability change was authorized.
The embedded provisioning profile matches the exact profile and certificate
above. A separately approved upload-only EAS submission
`dcd24fd9-16ef-455d-92a8-c3852b4cfcd3` finished transport for this exact build
and App Store Connect app `6801607849`. App Store Connect Build Uploads then
marked version 1.0.1/build 2 **Failed** with error 90683 because the binary lacks
`NSMotionUsageDescription`. That immutable binary is not eligible for retry or
TestFlight. No processed build, group assignment, tester, invitation, or
physical-device installation exists. A 1.0.4 replacement BUILD and later
upload remain pending separate fresh approvals.

## 3. Version/build automation and commands

`packages/mobile/app.json` owns the user-facing app version. Its runtime policy
is `appVersion`. For the current embedded-only runtime, every code or asset
change receives a new app version and store build. Push, authentication,
native, persistent-data-shape, runtime, start-event, human-only-action,
real-versus-drill, and live-provider-gate changes always require a new app
version and store build even after signed OTA is available in the future.

`packages/mobile/eas.json` uses `cli.appVersionSource: "remote"` and
`build.production.autoIncrement: true`. EAS assigns monotonically increasing
iOS build numbers and Android version codes. Read both counters before and
after every attempt; an EAS `{}` response means uninitialized, not failed.
From that exact state, preview the first production iOS BUILD as `{}` to `1`.
Preview the first production Android BUILD as `{}` to `2` because its implicit
local default `1` is auto-incremented; there is no separately stored remote `1`
transition. From numeric `N`, preview production BUILD as `N` to `N + 1`.
Never decrement, reuse, or silently discard a consumed value.

First establish the exact source and green local gate from the repository root:

```sh
git status --short
git rev-parse HEAD
bun install --frozen-lockfile
bun run check
bun run --cwd packages/mobile expo:check
```

Each remaining EAS code block in this section starts from the repository root
and changes into the Expo app root. Inventory the two public production
variables at both scopes. Do not copy raw output into the release record if it
contains any unrelated value:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 env:list production --scope project --format long
bunx eas-cli@21.7.0 env:list production --scope account --format long
```

Verify their exact effective values without inheriting conflicting local
values:

```sh
cd packages/mobile
env -u EXPO_PUBLIC_PSD_EOC_API_BASE_URL \
  -u EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED \
  bunx eas-cli@21.7.0 env:exec production \
  'test "$EXPO_PUBLIC_PSD_EOC_API_BASE_URL" = "https://eoc.psd401.net" && test "$EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED" = "true"' \
  --non-interactive
```

Resolve each profile and verify the security boundary in section 2:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 config --platform ios --profile production --json
bunx eas-cli@21.7.0 config --platform android --profile production --json
bunx eas-cli@21.7.0 build:version:get --platform ios --profile production --json
bunx eas-cli@21.7.0 build:version:get --platform android --profile production --json
```

Review the remote credential inventory through the approved EAS credential
view. Do not build if credentials are missing or if review would create or
repair them. After the exact BUILD consequence preview is approved, build one
platform at a time. The flags are defense in depth; the prior credential
read-back remains mandatory for Android:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 build --platform ios --profile production \
  --non-interactive --freeze-credentials
bunx eas-cli@21.7.0 build --platform android --profile production \
  --non-interactive --freeze-credentials
```

Rerun both version reads after success, error, timeout, or interruption. List
finished builds and inspect only exact IDs:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 build:list --platform ios --build-profile production --status finished
bunx eas-cli@21.7.0 build:list --platform android --build-profile production --status finished
bunx eas-cli@21.7.0 build:view 'EXACT_EAS_BUILD_ID' --json
```

Bind each candidate's platform, application identifier, profile, Git commit,
app version, native build number, finished status, artifact URL identity, and
downloaded SHA-256. Never use `--latest`, `--auto-submit`, a workflow, a branch
name, or an unreviewed local artifact for a write.

## 4. Physical-device installed identity

The authenticated **Release diagnostics** screen is read-only. It performs no
check, fetch, download, reload, publish, provider request, capability mutation,
or log/manifest read. After a cold launch of the exact TestFlight or Play
installation, it is acceptable evidence only when every row says:

- Evidence status: `Identity available`
- Application ID: `net.psd401.eoc`
- Application version: exact provider release version (`1.0.1` for the saved
  Android draft; `1.0.4` for the pending replacement iOS candidate)
- Native build version: exact provider build number in the release record
- Remote updates: `Disabled — embedded store bundle only`
- Launch source: `Embedded in this installed binary`
- Remote update ID: `Not applicable — remote updates disabled`
- Configured runtime version: the same exact installed application version
- Remote update channel: `Not applicable — remote updates disabled`
- Emergency launch: `No`

The screen reports `unknown` unless embedded app configuration and native Expo
state both prove the exact disabled/`NEVER` policy, embedded assets, absent
remote identity, app-version runtime policy, installed app version, and build
number. Any warning, mismatch, enabled update service, unexpected update ID,
channel, runtime, or emergency launch stops release verification. Record only
the non-sensitive values above and the physical verification time. Provider
inventory alone is not installed-device evidence.

Internal `development` and `preview` artifacts are never substitutes for
TestFlight or Play install evidence. If one is issued for engineering work,
require authenticated access, a named bounded staff-only technical audience,
audience digest and count, access expiry, planned removal time, and post-removal
read-back. A URL alone is never privacy. Access revocation cannot recall an
installed artifact, and downloaded Android bytes can be redistributed.

## 5. Consequence preview and approval

Before each provider mutation, append a fresh preview containing:

- exact Git SHA, EAS project, platform, profile, application identifier,
  app/runtime version, public API origin, expected cost, and remote-number
  transition for BUILD;
- exact immutable EAS/provider build identifiers and artifact digest for
  SUBMIT or TESTER EXPOSURE;
- fixed destination: `District Technology`, external `Staff` after its own
  review, or Play `alpha`;
- approved tester-list digest and count for exposure;
- whether the action uploads only, can invite, makes a build installable, or
  sends changes for provider review;
- current known-good rollback target or `no prior known-good build`; and
- every unresolved provider state.

The product owner approves that exact preview. The operator confirms the same
immutable identities immediately before the write. Any changed source, app
version, native number, artifact, audience, provider state, or consequence
invalidates approval. Building, uploading, and exposing are three separate
consequences.

## 6. iOS — TestFlight internal distribution

The committed `submit.production.ios` object pins only verified App Store
Connect app ID `6801607849`. That routing value does not prove an App Store
Connect API credential, provider upload, processing, TestFlight exposure, or
submission authority. No `.p8` path, tester group, Apple login, issuer, key, or
secret belongs in `eas.json`.

The App Store Connect record was read back on 2026-08-14 in provider `372148`:
name `PSD EOC`, bundle ID `net.psd401.eoc`, SKU `PSD-EOC-IOS`, primary language
English (U.S.) / `en-US`, and initial iOS version scaffold `1.0`. User Access is
Limited Access with zero new app-specific grants. The exact App Store profile
and finished iOS production BUILD recorded in section 2 exist. The upload-only
submission also occurred, but Apple rejected the binary during processing with
error 90683. No processed build, group, tester, invitation, or installation
exists.

1. Follow [the App Store runbook](appstore-setup.md) to read back the existing
   record and the numeric `ascAppId` immediately before any later write.
2. Confirm automatic distribution is disabled for every PSD EOC group.
3. After a separate SUBMIT preview and approval, upload only the exact build:

   ```sh
   cd packages/mobile
   bunx eas-cli@21.7.0 submit --platform ios --profile production \
     --id 'EXACT_REVIEWED_EAS_BUILD_ID' --non-interactive
   ```

4. Treat upload as upload only. Wait for processing and reconcile the provider
   build ID.
5. After a separate exposure preview and approval, associate the exact build
   with `District Technology`; then read back build/group membership.
6. Have an authorized internal tester install through TestFlight and complete
   sections 4 and 10. Processing or assignment alone is not install proof.

## 7. Android — Play internal pilot and durable alpha closed testing

The prior v1.0.0/code-2 AAB is prohibited by section 2. The exact reviewed
v1.0.1/code-3 replacement in section 2 is the only current candidate for Play
bootstrap. Its finished EAS state, digest, embedded-only policy, and upload-key
fingerprint must be re-read immediately before any separately authorized
provider write.

The exact eligible AAB is already saved manually as artifact
`4860219896995172827` in Internal testing draft release 1. Internal testing is
the approved bounded interim for no more than 100 testers. It is not the durable
D-022 path and does not satisfy issue #37's later closed-test bootstrap.

After closed-track app-signing, tester-group, and release-scoped service-account
evidence exist, later EAS Submit uses this fail-closed profile:

```json
{
  "track": "alpha",
  "releaseStatus": "draft",
  "changesNotSentForReview": true
}
```

After a separate SUBMIT approval, upload only the exact reviewed EAS build ID:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 submit --platform android --profile production \
  --id 'EXACT_REVIEWED_EAS_BUILD_ID' --non-interactive
```

Any later upload remains an unreleased draft. A human then verifies application ID,
app-signing identity, version name/code, AAB digest, `alpha` track, approved
Google Group, release notes, and warnings. Completing the draft, sending it for
review, and making it installable are a new TESTER EXPOSURE write requiring a
fresh preview, product-owner approval, human confirmation, and read-back.
Never promote to another track. An approved tester must install from the
ordinary Play Store before success is recorded.

Current external state on 2026-08-15: Play app `4972493736740021045` exists for
`net.psd401.eoc`; organization identity and both required phone roles are
verified. Internal draft release 1 contains only the exact 1.0.1/code-3 AAB and
reviewed release notes. No tester list, join link, preview/confirm, rollout,
exposure, or install exists. Durable Google Groups-based closed testing and its
release credential remain issue #37 work.

## 8. Staged private rollout

Membership controls exposure; no stage advances automatically.

1. **Upload, zero exposure.** Keep automatic TestFlight distribution disabled
   and Play in draft. Reconcile provider inventories.
2. **Technology pilot.** Expose only the smallest approved bounded pilot.
   Complete clean install, upgrade, sign-in, biometric, permission, and
   non-send real-versus-drill rendering checks on physical devices.
3. **Separately authorized synthetic push.** Issue #40 may perform a controlled
   test-mode push only under all live-send prerequisites. This runbook provides
   no shortcut and a push is not required to prove installation.
4. **Approved closed cohort.** Expand only after pilot evidence is accepted.
   Ordinary iOS staff use external `Staff` after Beta App Review; never grant
   App Store Connect roles merely to make staff internal testers. Android
   remains on the approved Play `alpha` group.

Stop on crash, authentication failure, misleading notification state,
real/drill ambiguity, unknown delivery truth, unexpected invitation, provider
drift, or incomplete evidence. Removing access does not uninstall a build.

## 9. Remote-update policy and rollback story

Remote updates are **blocked for current app/runtime 1.0.4**. The existing
embedded-only 1.0.1 provider artifacts are also incapable of remote updates.
There is no update URL, channel, verification build, automatic check, download
path, publication path, rollout, or OTA rollback command for these runtimes.
Every current code or asset change uses a new app version and store build.

This is deliberate fail-closed behavior. A safe OTA implementation needs work
outside issue #33's owned paths and a new native build. Before remote updates
can be enabled, a separate reviewed issue must provide:

- a district-held code-signing public certificate embedded in a new app
  version/runtime;
- private-key custody, rotation, recovery, and audit outside every repository;
- verified EAS plan entitlement and signed-publication behavior;
- an isolated pre-production verifier route and physical-device evidence;
- exact one-platform rollout, pause, read-back, and rollback procedures; and
- a new consequence preview, product-owner approval, and store build.

Future eligibility after that work is narrow:

| Change kind                                                                 | Future signed OTA eligibility                      |
| --------------------------------------------------------------------------- | -------------------------------------------------- |
| Copy, layout, or style only                                                 | Eligible only after isolated physical verification |
| JavaScript bug fix within existing contracts                                | Eligible only after isolated physical verification |
| Push, authentication, native code/config, runtime, or persistent data shape | Store build required                               |
| Start-event or another human-only action                                    | Store build and safety-path evidence required      |
| Real/drill classification or live-provider gate                             | Store build and safety-path evidence required      |
| Uncertain classification                                                    | Store build required                               |

The future rollback story is also fail-closed: stop expansion, preserve the bad
signed group ID, verify one compatible signed known-good group or the embedded
bundle, preview one platform only, obtain fresh approval and confirmation,
perform exactly one rollback mutation, independently reconcile all resulting
groups, and prove physical adoption. Offline devices may remain on old code;
no real activation is queued for later automatic send. No executable OTA
command is provided until the separately scoped signing and routing controls
exist.

### Current store rollback

For a bad current store build:

1. Stop new TestFlight assignment, invitation, Play draft completion, and
   audience expansion. Preserve exact identities and symptoms.
2. Detach or withdraw the bad closed-test build when safe. Record the provider
   result; stores cannot force-remove installed bytes.
3. Restore a previously proven known-good closed-test build if one exists. For
   the first release, record `no prior known-good build` and fix forward.
4. Create a new app version and monotonically incremented native build from
   reviewed known-good or corrected source, then repeat BUILD, SUBMIT, TESTER
   EXPOSURE, and physical evidence.
5. Communicate the manual update through approved human channels. Never claim
   withdrawal proves uninstall or adoption.

## 10. FINAL ACCEPTANCE human evidence — currently BLOCKED

These records remain blocked until humans perform the external steps. A mock,
simulator, build-success, upload, provider-processing result, or agent review
cannot replace them.

### iOS internal TestFlight install

- Status: **BLOCKED — Apple processing failed for uploaded iOS v1.0.1/build 2;
  no eligible 1.0.4 replacement, TestFlight group assignment, or human install
  evidence exists**
- App record read-back: provider `372148`, Apple ID `6801607849`, name
  `PSD EOC`, bundle ID `net.psd401.eoc`, SKU `PSD-EOC-IOS`, `en-US`, initial
  version `1.0`, Limited Access with zero new app-specific grants; Build Uploads
  records 1.0.1/build 2 as Failed with error 90683 and TestFlight contains no
  processed build, group assignment, tester, or invitation
- Exact EAS build ID and artifact digest:
  `e68d07aa-98e5-4c87-8595-52175975291f` / build `2` /
  `7c22776b959bb8f015f077b8fc73247b005b298ae97e18240d50aea77432adb9`
- EAS submission / App Store processing:
  `dcd24fd9-16ef-455d-92a8-c3852b4cfcd3` finished transport; Apple processing
  failed with 90683; replacement 1.0.4 identity is `PENDING — not built yet`
- `District Technology` group read-back: `BLOCKED`
- Section 4 embedded-only diagnostic read-back: `BLOCKED`
- Physical device/OS and TestFlight-install timestamp: `BLOCKED`
- Human verifier role and non-sensitive evidence link: `BLOCKED`

### Android Play internal install

- Status: **BLOCKED — the exact AAB is saved in an Internal-testing draft, but
  no tester audience, rollout, installability, or human install evidence exists**
- Play account/app read-back: app `4972493736740021045`, package
  `net.psd401.eoc`; organization identity and both required phone roles are
  verified; Play App Signing is active
- Superseded v1.0.0 build evidence: EAS
  `856e54b5-9abd-45a5-b0db-809a295da5ef`, source `577cd741...`, code `2`, AAB
  SHA-256 `015911fa614ba7b264f71a5f3186ab9c86940f94b98d77861b2864a761506463`;
  **not eligible for upload or install**
- Eligible v1.0.1 replacement BUILD evidence: EAS
  `3742b81d-3942-4fea-b760-53c809d8733f`, source
  `71e08fa8358f6890e5419289b163aaa0fb0af081`, version code `3`, AAB SHA-256
  `915247b2a3c4c7eb97d685dd04e8886cf93f6caed24d605ac9991166faa64246`;
  saved as artifact `4860219896995172827` in Internal testing draft release 1
- Internal tester-list digest/count, join link, preview/confirm, and rollout
  read-back: `BLOCKED`
- Section 4 embedded-only diagnostic read-back: `BLOCKED`
- Physical device/OS and Play-install timestamp: `BLOCKED`
- Human verifier role and non-sensitive evidence link: `BLOCKED`

### Non-engineer guide walkthrough

- Provider/device screenshots: **BLOCKED — current SVGs are illustrated advance
  references, not provider screenshots**. After the exact TestFlight and Play
  builds are installable, capture sanitized screenshots from those exact
  provider/device flows, remove account names, tester identities, device IDs,
  messages, tokens, and unrelated apps, replace or supplement the illustrations,
  and review the sanitized result before committing it. Do not fabricate or
  relabel an illustration as provider evidence.
- Status: **BLOCKED — walkthrough not recorded**
- Verifier role, platform, guide commit, and date: `BLOCKED`
- Steps completed without author assistance: `BLOCKED`
- Accessibility or wording gaps and follow-up links: `BLOCKED`

### Approval and final acceptance

- Status: **BLOCKED — product-owner sign-off not recorded**
- Exact completed-checklist and sign-off references: `BLOCKED`
- Issue #23 repository evidence:
  [mobile push evidence](../evidence/issue-23-mobile-push.md)
- Issue #38 repository automation:
  [merged PR #56](https://github.com/psd401/psd-eoc/pull/56)
- Issue #37 provider bootstrap evidence: `BLOCKED`
- Integration truth-register review: `BLOCKED`

Only the responsible human may replace a `BLOCKED` value with contemporaneous,
non-sensitive evidence. Product-owner sign-off is never inferred or supplied
by an agent or automation. FINAL ACCEPTANCE does not itself authorize go-live,
production deployment, provider configuration, a real incident, a real
notification, an all-clear, or closing a real event.
