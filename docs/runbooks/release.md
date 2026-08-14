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
- Android: `net.psd401.eoc`, Play **Closed testing — Alpha** (`alpha`) track.
  The first AAB is uploaded manually; later EAS submissions remain unreleased
  drafts until a human separately reviews and releases them.
- App/runtime 1.0.1 uses only code and assets embedded in its store binary.
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
- `net.psd401.eoc`, app/runtime 1.0.1, and embedded-only update policy;
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
      app/runtime 1.0.1, remote updates disabled, automatic checks set to
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

App/runtime 1.0.1 supersedes the prior Android artifact before store exposure.
Its committed configuration must remain exactly:

- `updates.enabled: false`;
- `updates.checkAutomatically: "NEVER"`;
- `updates.useEmbeddedUpdate: true`;
- `updates.disableAntiBrickingMeasures: false`;
- no update URL;
- no `channel` in any EAS build profile; and
- no OTA-verification build profile.

Expo SDK 57's current compatible patch set includes `expo-updates` 57.0.14.
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

The replacement Android build is expected to advance remote version code
`2` to `3` only if a fresh EAS read-back immediately before BUILD still proves
`2`. Until the post-build read-back exists, record version code `3` as
`EXPECTED — NOT PROVEN`, never as an artifact identity. The iOS build number is
likewise whatever a fresh remote read-back and approved transition establish.
Prior approval for source `577cd741...`, version 1.0.0, or code 2 does not
authorize the replacement.

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
  bunx eas-cli@21.7.0 env:exec production --non-interactive -- \
  sh -c 'test "$EXPO_PUBLIC_PSD_EOC_API_BASE_URL" = "https://eoc.psd401.net" && test "$EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED" = "true"'
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
- Application version: `1.0.1`
- Native build version: exact provider build number in the release record
- Remote updates: `Disabled — embedded store bundle only`
- Launch source: `Embedded in this installed binary`
- Remote update ID: `Not applicable — remote updates disabled`
- Configured runtime version: `1.0.1`
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

The committed `submit.production.ios` object is intentionally empty and blocks
non-interactive submission. It does not prove credentials, an app record, or a
finished iOS build. No `.p8` path, tester group, Apple ID, or secret belongs in
`eas.json`.

1. Follow [the App Store runbook](appstore-setup.md) to human-create and verify
   the `net.psd401.eoc` record and review the numeric `ascAppId` into config.
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

## 7. Android — Play alpha closed testing

The prior v1.0.0/code-2 AAB is prohibited by section 2. Only a reviewed v1.0.1
replacement artifact that passes the full gate and exact BUILD read-back may be
used for Play bootstrap.

The first eligible AAB is uploaded manually in Play Console under issue #37.
After first-upload, app-signing, closed tester group, and release-scoped service
account evidence exist, later EAS Submit uses this fail-closed profile:

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

The upload remains an unreleased draft. A human then verifies application ID,
app-signing identity, version name/code, AAB digest, `alpha` track, approved
Google Group, release notes, and warnings. Completing the draft, sending it for
review, and making it installable are a new TESTER EXPOSURE write requiring a
fresh preview, product-owner approval, human confirmation, and read-back.
Never promote to another track. An approved tester must install from the
ordinary Play Store before success is recorded.

Current external state on 2026-08-14: the organization website is verified,
the account is classified as government, and organization and authorized-
representative identity documents have been submitted. Google identity review
is pending; phone verification and app creation remain locked. This is an
external provider wait, not evidence that an app or release exists.

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

Remote updates are **blocked for app/runtime 1.0.1**. There is no update URL,
channel, verification build, automatic check, download path, publication path,
rollout, or OTA rollback command for this runtime. Every current code or asset
change uses a new app version and store build.

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

- Status: **BLOCKED — no verified App Store Connect record, finished iOS
  v1.0.1 production build, group assignment, or human install evidence**
- Exact EAS build ID and artifact digest: `BLOCKED`
- Exact App Store Connect build ID/version/build number: `BLOCKED`
- `District Technology` group read-back: `BLOCKED`
- Section 4 embedded-only diagnostic read-back: `BLOCKED`
- Physical device/OS and TestFlight-install timestamp: `BLOCKED`
- Human verifier role and non-sensitive evidence link: `BLOCKED`

### Android Play alpha install

- Status: **BLOCKED — Google identity review is pending; app creation, eligible
  v1.0.1 upload, release, and human install evidence do not exist**
- Play account read-back: organization and representative documents submitted
  2026-08-14; phone verification and app creation locked pending Google review
- Superseded v1.0.0 build evidence: EAS
  `856e54b5-9abd-45a5-b0db-809a295da5ef`, source `577cd741...`, code `2`, AAB
  SHA-256 `015911fa614ba7b264f71a5f3186ab9c86940f94b98d77861b2864a761506463`;
  **not eligible for upload or install**
- Eligible v1.0.1 replacement EAS build ID/version code/digest: `BLOCKED`
  (`3` is expected only if the fresh pre-build counter still proves `2`)
- Play `alpha` release and tester-group digest/count read-back: `BLOCKED`
- Section 4 embedded-only diagnostic read-back: `BLOCKED`
- Physical device/OS and Play-install timestamp: `BLOCKED`
- Human verifier role and non-sensitive evidence link: `BLOCKED`

### Non-engineer guide walkthrough

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
