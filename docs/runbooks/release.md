# Mobile release and rollback runbook

This runbook governs private PSD EOC mobile distribution. It does not authorize
a production deployment, a public store release, a real incident, or a real
notification. Every EAS build, submit, TestFlight assignment, Play release, and
production OTA write is performed by an authorized human from
`packages/mobile`; none runs from CI or by schedule. Stop when an identity,
credential, target, build, consequence, approval, or provider result is missing,
stale, or ambiguous.

Release 1 targets are fixed:

- iOS: `net.psd401.eoc`. The first install proof uses the private TestFlight
  internal group `District Technology`; any later ordinary-staff cohort uses
  only the external group `Staff` after its separate Beta App Review gates.
- Android: `net.psd401.eoc`, Play **Closed testing — Alpha** (`alpha`) track.
  EAS uploads an unreleased draft; a human separately reviews and releases it.
- No build is promoted to an App Store public release or Play `beta` or
  `production` track by this runbook.

Read [App Store Connect and TestFlight setup](appstore-setup.md) before any
Apple operation. Staff installation steps live in
[the iOS guide](../guides/install-ios.md) and
[the Android guide](../guides/install-android.md).

## 1. Release record and progressive gates

Create one private, append-only operational record for the release. Append the
preview, exact product-owner approval, fresh authenticated-human confirmation,
provider result, and read-back for each gate; correct mistakes with a
superseding entry rather than rewriting earlier evidence. The record must
contain no credential, token, private key, tester address, real recipient
export, student data, or raw provider response. Record:

- release owner and human operator roles;
- product-owner approval reference, scope, and time;
- exact Git commit SHA and clean-worktree proof;
- `expo.version` and resulting EAS runtime version;
- exact iOS and Android EAS build IDs, platform, profile, artifact identity,
  resolved iOS build number, and resolved Android version code;
- the complete pre- and post-gate EAS channel-to-branch mapping and compatible
  update inventory for the exact platform and runtime;
- exact App Store Connect build ID and Play release/version-code identity;
- fixed TestFlight group or Play track and the approved tester-list digest and
  count, never the tester identities;
- consequence-preview digest or signed reference, provider outcome, and links
  to non-sensitive install evidence;
- known-good store builds, OTA update groups, and embedded runtime to use for
  rollback.

A downstream identifier that does not exist yet is recorded as
`PENDING — not created yet`. Never invent it or treat its absence as a reason to
block an earlier gate that creates it.

These conditions apply to every gate:

- [ ] Credentials needed for the current gate are verified, least privilege,
      and held in the approved secrets systems; no credential file is inside
      any Git repository.
- [ ] `bun install --frozen-lockfile` and `bun run check` pass on the exact
      release commit.
- [ ] The mobile distribution configuration test and native prebuild check pass
      on that commit.
- [ ] No gate uses student or guardian data, an unknown tester, a real recipient
      export, or a real-incident activation as release evidence.
- [ ] Missing, stale, conflicting, partial, or indeterminate identity,
      credential, target, build, approval, provider result, or read-back stops
      the current gate.

Approval for one gate never authorizes another. Every provider write requires
a fresh exact consequence preview, explicit product-owner approval, and fresh
authenticated-human confirmation immediately before that write.

### BUILD

The BUILD preview binds the exact clean Git SHA, platform, `production` profile,
application identifier, app version/runtime, public API origin, compiled push-
registration switch, expected cost, exact remote build-number transition, and
the complete pre-build update-routing state. Before an authorized human starts
it:

- [ ] Read-only EAS production-environment evidence shows exactly one
      `EXPO_PUBLIC_PSD_EOC_API_BASE_URL` set to the public, non-secret origin
      `https://eoc.psd401.net`. The resolved iOS and Android production build
      profiles contain that exact value; absence, another origin, a
      credential/query/path fragment, or a conflicting account-level value
      blocks the build.
- [ ] Read-only EAS production-environment evidence also shows exactly one
      plaintext string `EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED` at
      project scope with the exact value `true`, no account-scope variable of
      the same name, and that exact effective value in both resolved production
      profiles. This compiled opt-in is required for the release candidate and
      makes the installed binary capable of registration. BUILD approval alone
      does not authorize installation, sign-in, registration, a provider test,
      or a notification. Missing, malformed, conflicting, or disabled state
      blocks BUILD.
- [ ] The signing and EAS configuration required for that platform is verified
      without placing credentials in the repository. Required remote signing
      credentials and provisioning are pre-provisioned and read back; BUILD
      runs non-interactively with frozen credentials and stops instead of
      creating, repairing, selecting, or refreshing credentials. For Android,
      EAS CLI 21.7.0 does not reliably apply `--freeze-credentials` while
      setting up a missing remote keystore: separately read back the exact
      default remote keystore first and never invoke BUILD if it is absent or
      indeterminate.
- [ ] A complete, paginated inventory binds the exact `production`
      channel-to-branch mapping and every update compatible with the platform
      and runtime. A separately previewed BUILD may create and link the
      same-name channel and branch only when both are absent. A missing channel
      with an existing same-name branch is partial state: linking it could
      expose that branch's updates to already installed clients, so BUILD must
      not proceed. If the channel exists, it must already map to exactly one
      existing same-name branch; BUILD may not repair it. Any different,
      partial, multiple, unreviewed, or indeterminate state or incomplete
      pagination is recorded explicitly and fails closed.
- [ ] The preview states that BUILD creates the exact EAS artifact and, only
      when the inventory proves both are absent, may create and link the exact
      same-name `production` channel and branch under the rule above. It does
      not submit, assign a group, invite a tester, publish an OTA, expose a
      build, or authorize any PSD EOC notification.

After BUILD, even after a refusal or partial failure, reread the exact remote
native-version counter, credential identity, channel, branch, compatible-update
state, build records, and quota/cost state. Append that read-back plus the
immutable EAS build ID, resolved native build number, source-upload/build-job
status, artifact digest, and status. EAS may increment a remote build number or
create an orphan same-name branch before credentials, channel creation, source
upload, or the build itself succeeds; retain that consumed number and partial
state, and never decrement, reuse, or blindly retry. Any unpreviewed credential
or routing change blocks every later gate. Issue #37's first manual AAB upload
and issue #40's physical-device delivery consume these BUILD artifacts;
completion of #37 or #40 is not a BUILD prerequisite.

### SUBMIT

The SUBMIT preview binds one exact finished EAS build ID and digest to one
verified provider account and application record:

- [ ] For iOS, the reviewed numeric `ascAppId` is present, the complete
      TestFlight inventory has been reconciled, and automatic distribution is
      disabled for every PSD EOC group.
- [ ] For Android's first release, an authorized human uses Play Console to
      upload the exact BUILD AAB and verify its digest as issue #37's bootstrap
      step. Later EAS submissions require issue #37's completed first-upload
      and release-scoped service-account evidence.
- [ ] The preview is upload-only. The Play release remains an unreleased draft,
      and neither provider action sends invitations or makes the build
      installable.

Append the provider build/release identity, processing state, warnings, and
read-back. Upload acceptance is not tester exposure or human installation.

### TESTER EXPOSURE

The TESTER EXPOSURE preview binds one exact processed provider build/release to
the fixed `District Technology` TestFlight group or Play `alpha` track. It also
binds the approved tester-list digest and count, invitation/installability
consequences, and the withdrawal or fix-forward target.

- [ ] The bounded private audience is product-owner approved, staff-only, and
      contains no student, guardian, real recipient export, or unknown member.
- [ ] Apple build/group association or invitation and Play draft
      completion/release are separately previewed, approved, freshly confirmed,
      and read back; one never authorizes the other.
- [ ] Immediately before each exposure or install, and again immediately after
      provider processing and the device's second online cold launch, reread
      the complete `production` channel-to-branch and platform/runtime update
      inventory. In that same uninterrupted authenticated physical-device
      session, perform **LAUNCHED IDENTITY READ-BACK** with
      `APPROVED_CHANNEL` set to `production`. Any drift, unknown device or
      embedded-artifact identity, compatible unreviewed update, emergency
      launch, or indeterminate selection blocks exposure evidence and final
      acceptance.
- [ ] Tester exposure authorizes installation only. It does not authorize a
      PSD EOC notification, a real incident, or ordinary-staff expansion.
- [ ] Before installation or sign-in, the preview binds the exact approved
      synthetic staff-context account and verifier device and states that an
      authenticated online session with already granted notification permission
      automatically acquires a native token, contacts Expo for an Expo token,
      and registers that token with PSD EOC. Verified provider credentials, the
      approved synthetic target, an exact registration consequence preview,
      explicit product-owner approval, and fresh authenticated-human
      confirmation must be current. Keep push registration disabled on any
      device outside that bounded run.

After installation, any controlled synthetic push is a separate issue #40
action. It requires verified credentials, an approved synthetic target list, a
consequence preview, explicit product-owner authorization, and authenticated-
human confirmation. Use test mode only; never start a real incident or send a
live staff notification, and prove the real-versus-drill display remains
unambiguous.

At the current repository state, issue #40 cannot yet perform that first send
through the canonical app path: the Expo transport requires a `live-verified`
integration before provider I/O, while issue #40 correctly retains `mocked`
until both physical runs are proven. This runbook does not weaken that gate or
permit a dashboard/CLI shortcut. Issue #40 needs its own owned, reviewed ordering
or narrowly scoped app-confirmed verification-path decision; until then its
physical-send evidence and this runbook's FINAL ACCEPTANCE remain blocked.

### FINAL ACCEPTANCE

FINAL ACCEPTANCE is a read-only evidence decision, not a provider-write
authorization. It requires exact physical TestFlight and Play install
identities/read-backs, the launched embedded-build or OTA-group identity after
the second online cold launch, the non-engineer guide walkthrough, issue #37's
durable Play evidence, issue #40's separately authorized controlled
physical-push evidence, integration truth labels that claim only what is
proven, and explicit human product-owner acceptance. If an installed app cannot
complete **LAUNCHED IDENTITY READ-BACK** with `APPROVED_CHANNEL` set to
`production`, retain `unknown`; a provider inventory alone is not
device-adoption proof.

Closed issues #23 and #38 establish only their recorded repository-side
automation; neither substitutes for provider or physical-device evidence.
FINAL ACCEPTANCE does not authorize a production deployment, ordinary-staff
expansion, a real incident, a real notification, an all-clear, or closing a real
event.

An old approval, a credential, a passing mock, or a successful upload is not
approval for distribution. A partial or indeterminate provider response is a
stop condition: inspect provider state read-only and create a fresh plan; never
blindly retry.

Inspect both production variable scopes without requesting sensitive values,
then prove the effective public API origin and push-registration switch and
resolve both production profiles. For each named variable, project scope must
contain exactly one plaintext string with the expected value and account scope
must contain no variable of the same name. `env:exec` proves the values produced
by EAS precedence without printing them; `config` alone does not prove a
variable's source or value. Do not use `--include-sensitive` or a file variable,
and do not copy the full output into a public record:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 env:list production --scope project --format long
bunx eas-cli@21.7.0 env:list production --scope account --format long
env -u EXPO_PUBLIC_PSD_EOC_API_BASE_URL \
  -u EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED \
  bunx eas-cli@21.7.0 env:exec production \
  'test "$EXPO_PUBLIC_PSD_EOC_API_BASE_URL" = "https://eoc.psd401.net" && test "$EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED" = "true"' \
  --non-interactive
bunx eas-cli@21.7.0 config --platform ios --profile production --json
bunx eas-cli@21.7.0 config --platform android --profile production --json
```

Record the two public effective values, scope/name/type inventory digest, and
resolved-profile digest in the private append-only release record. Setting or
changing either EAS variable is a separate provider mutation with its own exact
preview and approval; these read-only commands do not authorize it.

### LAUNCHED IDENTITY READ-BACK (`production` and `ota-verification`)

Use this same procedure for every physical store install, internal OTA verifier,
FINAL ACCEPTANCE decision, and post-rollback verification. Set
`APPROVED_CHANNEL` to exactly `production` or `ota-verification` for the
reviewed build; never infer or substitute it. In one uninterrupted authenticated
device-verification session after the required online cold launch, **Release
diagnostics** must report:

- `Identity available`, application ID `net.psd401.eoc`, and the exact
  provider/EAS app version and native build number;
- the exact expected runtime and `APPROVED_CHANNEL`;
- `Emergency launch: No`; and
- one canonical lowercase update UUID plus exactly one launch source.

An emergency launch, `Unknown`, field mismatch, changed session, screenshot
without live read-back, or inability to prove the exact physical installation
blocks exposure, rollback evidence, and acceptance. Bind the diagnostic's native
identity independently to the exact EAS build ID, profile, clean Git SHA,
application identifier, resolved app/runtime/native versions, artifact SHA-256,
and—when store-installed—the exact App Store Connect/TestFlight or Play build
and install record. Provider processing is not physical-device adoption.

Then branch on the diagnostic's launch source:

- **Embedded in this installed binary.** Hash the exact downloaded IPA, AAB, or
  APK before inspection. Enumerate archive metadata without extraction and
  reject encryption, links, absolute or traversal paths, duplicate names,
  multiple app bundles, or multiple recognized embedded manifests. The current
  managed build must contain exactly one runtime-consumed manifest at
  `Payload/<single-app>.app/EXUpdates.bundle/app.manifest` for iOS,
  `base/assets/app.manifest` for an Android AAB, or
  `assets/app.manifest` for an Android APK. The iOS native loader's legacy
  main-bundle fallback is not an allowed release-artifact shape; any other or
  ambiguous layout blocks.

  Stream only that one entry to a local JSON parser without printing or copying
  the manifest or its asset list. Require a JSON object whose top-level `id` is
  one canonical lowercase UUID exactly equal to the diagnostic update ID. The
  manifest UUID binds the embedded bundle to the already hashed artifact; it
  does not contain or prove runtime, channel, EAS/store build ID, Git SHA,
  device identity, launch time, or receipt, which remain independently bound by
  the diagnostic and build/provider records above.

  Do not require `update:embedded:list` or `update:embedded:view`. Ordinary
  builds are not registered there: Expo's embedded-bundle upload is experimental
  and opt-in through
  `EAS_UPDATE_EXPERIMENTAL_UPLOAD_EMBEDDED_BUNDLE=1`, which this project does
  not enable. Enabling it or manually uploading a bundle would be a separate
  reviewed BUILD/provider consequence, never an evidence shortcut.
- **Downloaded over-the-air update.** Pass the exact diagnostic update ID—not
  merely a group ID—to:

  ```sh
  cd packages/mobile
  bunx eas-cli@21.7.0 update:view \
    'EXACT_DIAGNOSTIC_UPDATE_ID' --json
  ```

  Require the returned JSON array to contain exactly one update total. Its
  `id`, platform, runtime, branch, `gitCommitHash`, and group must equal the
  approved physical platform, diagnostic runtime, same-name branch for
  `APPROVED_CHANNEL`, reviewed clean commit, and exact approved group. An
  exact group match with an extra platform update is a block, not adoption
  evidence. The separately inventoried canonical channel mapping must still
  bind that branch.

  EAS CLI 21.7.0 `update:view --json` omits rollout percentage and
  `rolloutControlUpdate`. Use the complete paginated `update:list` inventory
  for group rollout summaries and raw `channel:view APPROVED_CHANNEL --json`
  for the mapped branch's latest overall group's percentage and control-update
  references. Immediately after creating a rollout, append those immutable
  references. Bind all three read-backs to a determinate current selection; a
  missing page, stale latest group, unreviewed or changed control reference,
  mixed platform/runtime, or indeterminate rollout retains `unknown`.

Record only the minimized identities and non-sensitive digests in the private
append-only release record. Never record a manifest, asset list, internal-build
URL, user/device identifier, credential, token, or recipient data.

### INTERNAL BUILD ACCESS (`development`, `preview`, and `ota-preview`)

Every internal-distribution profile is private infrastructure. Before creating,
sharing, opening an install page for, or installing a `development`, `preview`,
or `ota-preview` artifact, an authorized human must read back that
**Unauthenticated access to internal builds** is disabled for the exact
`peninsula-school-district/psd-eoc` project. Reconcile project membership and
artifact access to one product-owner-approved, named, bounded staff-only
technical audience. Record only the audience digest and count, approval
reference, access expiry, planned removal time, and post-removal read-back.

An unknown member, student or guardian, public/unauthenticated access, stale
audience, missing expiry/removal proof, or inability to read back the setting
blocks the build and every install. An internal-build URL is a bearer-like
distribution pointer: never place one in a repository, issue, PR, public chat,
or screenshot. A URL alone is never privacy, audience, install, or launched-
bundle evidence. Immediately before each share or install and after audience
removal, repeat the access-setting and digest/count read-back. These controls
apply independently to all three internal profiles; satisfying them for one
artifact or profile never satisfies another.

Do not sign in to an internal build until the exact synthetic staff-context
account and verifier device, automatic push-registration consequence, verified
credentials, product-owner approval, and fresh authenticated-human confirmation
required by TESTER EXPOSURE are current. Build creation can precede issue #40's
physical send evidence; registration and any later DRILL send remain separately
controlled actions.

Access expiry or revocation cannot recall an installed artifact, and downloaded
Android bytes can be redistributed after the original URL stops working. The
iOS provisioning device allowlist must exactly match the approved bounded
device audience. Record removal and device cleanup explicitly; do not infer
either from a disabled link.

## 2. Version and immutable-build policy

`packages/mobile/app.json` owns the user-facing `expo.version`. Its
`runtimeVersion` policy is `appVersion`, so that version also separates OTA
compatibility. Set it deliberately before a new release cycle. Increment it for
every push, authentication, native, persistent-data-shape, runtime, start-event,
human-only-action, real-versus-drill-classification, or live-provider-gate
change. A safety-path fix always gets a new app version/runtime even when its
code happens to be JavaScript-only; otherwise an older OTA could supersede the
fixed embedded bundle. Never publish an OTA across incompatible native code or
safety boundaries.

`packages/mobile/eas.json` uses `cli.appVersionSource: "remote"` and
`build.production.autoIncrement: true`. EAS therefore assigns monotonically
increasing iOS build numbers and Android version codes. EAS CLI 21.7.0 reports
an uninitialized remote counter as `{}` with exit status zero; that means no
remote counter exists yet, not that the read failed. From that exact state, the first
production iOS BUILD is previewed as `{}` to `1`; the first production Android
BUILD is previewed as `{}` to `2` because its implicit local default `1` is
auto-incremented, with no separately stored remote `1` transition. If an
`ota-preview` build already initialized either counter to `1`, the next
production BUILD is `1` to `2`. From any existing numeric `N`, a production
BUILD is previewed as `N` to `N + 1`. Never edit a number to reuse an already
uploaded store identity. Record EAS's resolved values after each build; the Git
repository does not contain those remote counters.

Before a build, enumerate every page of channels and branches, then bind the
exact channel, its linked branch, and every compatible update for the target
platform and runtime. Replace each `OFFSET` with successive offsets until the
returned page is empty; retain a non-sensitive digest of the complete
inventory. When neither the `production` channel nor same-name branch exists,
EAS Build may create and link that pair as part of the separately approved BUILD
consequence. A missing channel with an existing same-name branch blocks BUILD:
linking it can expose that branch's updates to installed production-channel
clients and requires a separate routing/exposure review. When the channel
already exists, it must map to exactly one existing same-name branch; BUILD may
not create or repair routing. Any other partial, unexpected, multiple, or
indeterminate state, or any compatible update whose source, rollout, and
expected launch identity are not proven, blocks the build:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 channel:list --limit 25 --offset 'OFFSET' --json
bunx eas-cli@21.7.0 branch:list --limit 50 --offset 'OFFSET' --json
bunx eas-cli@21.7.0 channel:view production --limit 50 --offset 'OFFSET' --json
bunx eas-cli@21.7.0 branch:view production --limit 50 --offset 'OFFSET' --json
bunx eas-cli@21.7.0 update:list --branch production --platform ios \
  --runtime-version 'EXACT_RUNTIME_VERSION' --limit 50 --offset 'OFFSET' --json
bunx eas-cli@21.7.0 update:list --branch production --platform android \
  --runtime-version 'EXACT_RUNTIME_VERSION' --limit 50 --offset 'OFFSET' --json
bunx eas-cli@21.7.0 update:view 'EACH_COMPATIBLE_UPDATE_GROUP_ID' --json
```

`update:list` is only a group-level summary, but its complete paginated JSON
supplies each group's rollout percentage. Run `update:view` for every compatible
group and bind every platform update ID, runtime, branch, source
`gitCommitHash`, and message. That JSON omits rollout percentage and
`rolloutControlUpdate`; use raw `channel:view --json` for the mapped branch's
latest group's exact percentage and control-update ID/group references. An
unreadable group, incomplete page, stale latest group, or disagreement among
these read-backs blocks BUILD and exposure.

Read back and record each remote native-version counter before BUILD. Also use
the provider credential inventory or approved EAS credentials dashboard to
bind the exact iOS distribution certificate/provisioning profile or Android
default remote keystore. Treat a missing Android keystore as a hard stop; do
not rely on `--freeze-credentials` to prevent EAS CLI 21.7.0 from creating one:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 build:version:get --platform ios --profile production --json
bunx eas-cli@21.7.0 build:version:get --platform android --profile production --json
```

Build only a clean, reviewed commit, with those exact already provisioned
remote credentials, and never combine building with submission. Keep both
flags as defense in depth, and as a hard freeze for supported iOS credential
actions; do not retry interactively or without them:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 build --platform ios --profile production \
  --non-interactive --freeze-credentials
bunx eas-cli@21.7.0 build --platform android --profile production \
  --non-interactive --freeze-credentials
```

Rerun both `build:version:get` commands after success, refusal, or partial
failure and append the result. The only allowed change is the exact
platform-specific initialization or increment named in the approved preview;
an unexpected value, an Android `{}` to `1` production result, a consumed value
not appended to the record, or an indeterminate read-back blocks all later
gates.

List finished builds read-only, then inspect each exact candidate:

```sh
bunx eas-cli@21.7.0 build:list --platform ios --build-profile production --status finished
bunx eas-cli@21.7.0 build:list --platform android --build-profile production --status finished
bunx eas-cli@21.7.0 build:view 'EXACT_EAS_BUILD_ID' --json
```

For each platform, bind the release record to one immutable EAS build ID. The
viewed platform, application identifier, `production` profile, Git commit,
app/runtime version, native build number, and finished status must all match the
reviewed release. Downloaded artifacts should also have their SHA-256 digest
recorded privately. A mismatch blocks release.

Never use `--latest`, `--auto-submit`, an EAS workflow, a branch name, or an
unreviewed local artifact for a write. A new build that finishes after review
cannot replace the exact recorded build ID.

## 3. Consequence preview and approval

Before each provider mutation, record the gate-specific fresh consequence
preview. A BUILD preview uses the pre-build identities: exact Git SHA, EAS
project, platform, profile, application identifier, app/runtime version, public
API origin, cost, and remote-number increment. SUBMIT and TESTER EXPOSURE also
use the immutable EAS/provider identifiers created by earlier gates. Record:

- every immutable EAS and provider build identifier and version value that
  exists for the current gate; identifiers created by this gate remain
  `PENDING — not created yet` until read-back;
- the fixed application and destination: `net.psd401.eoc` in TestFlight
  internal `District Technology`, TestFlight external `Staff` with its Beta App
  Review consequences, or Play `alpha` closed testing;
- for TESTER EXPOSURE, the approved tester-list digest and count;
- whether the action uploads only, can send an invitation, makes a build
  installable, changes rollout exposure, or submits anything for review;
- the current known-good rollback target and any unresolved provider state. For
  the first release, record `no prior known-good build` plus a withdrawal and
  fix-forward plan; that truth does not block artifact creation.

The product owner approves that exact preview. The human operator then confirms
the same immutable identifiers immediately before the write. Any build,
audience, provider-state, target, or consequence change invalidates approval.
Uploading a build and exposing it to testers are separate consequences and
require separate confirmations.

## 4. iOS — TestFlight internal distribution

The committed `submit.production.ios` object is intentionally empty and blocks
non-interactive submission. It does not prove that App Store Connect
credentials or an app record exist. The read-only audit on 2026-08-12 found no
connected App Store Connect integration and no finished iOS production build
in EAS. No `.p8` path, tester group, Apple ID, or secret belongs in `eas.json`.
Follow the provisioning and reviewed `ascAppId` change described in
[the App Store runbook](appstore-setup.md).

1. Confirm the reviewed profile contains the exact numeric `ascAppId` for the
   already human-created and verified `net.psd401.eoc` record. Stop if it is
   empty; do not use interactive submission to create or select an app
   implicitly.
2. Confirm automatic distribution is disabled for every PSD EOC TestFlight
   group and reconcile any unknown group or member before upload.
3. Submit only the exact reviewed EAS build ID:

   ```sh
   cd packages/mobile
   bunx eas-cli@21.7.0 submit --platform ios --profile production \
     --id 'EXACT_REVIEWED_EAS_BUILD_ID' --non-interactive
   ```

4. Treat upload success only as an upload. Wait for Apple processing, then use
   the App Store script's read-only `--build latest` discovery solely to learn
   the provider ID. Rerun its preview with that exact ID; apply mode rejects
   `latest`.
5. After a fresh digest-bound approval, associate that exact processed build
   with the private internal `District Technology` group. Verify the exact
   build/group relationship and group membership by read-back.
6. Have an authorized internal-group human install the build and record the
   evidence in section 9. Do not describe processing, invitation, or group
   assignment alone as an installable-build test.

## 5. Android — Play alpha closed testing

BUILD creates the exact AAB needed for issue #37's first-upload bootstrap; #37
completion is not a BUILD prerequisite. An authorized human then creates and
verifies the organization/app record and manually uploads the exact AAB digest
in Play Console. Issue #37's first-upload, closed tester group, and
release-scoped Play API service-account evidence must be complete before any
subsequent EAS Submit. The committed submission profile is fail-closed:

```json
{
  "track": "alpha",
  "releaseStatus": "draft",
  "changesNotSentForReview": true
}
```

It can upload only to the Play `alpha` track as a draft and deliberately does
not make the build installable or send changes for review. Submit only the
exact reviewed EAS build ID:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 submit --platform android --profile production \
  --id 'EXACT_REVIEWED_EAS_BUILD_ID' --non-interactive
```

After upload, a human opens Play Console and verifies the exact application ID,
app-signing identity, version name/code, AAB, `alpha` closed track, approved
Google Group, release notes, and every warning. Completing the draft, sending
changes for review, and making the build available are a new provider write:
produce a fresh consequence preview, obtain exact product-owner approval, and
confirm it manually. Never promote it to another track. Read back the release
status and have an approved tester install from the ordinary Play Store before
recording success.

## 6. Staged store rollout

Membership controls exposure; no stage advances automatically.

1. **Upload, zero exposure.** Keep automatic TestFlight distribution disabled
   and the Play release in draft. Reconcile both provider inventories.
2. **Technology pilot install.** Assign the exact iOS build only to `District
Technology`; release the exact Android build only to the smallest approved
   `alpha` pilot group. Complete clean install, upgrade, sign-in, biometric,
   push-permission, and non-send real-versus-drill rendering checks on physical
   devices.
3. **Separately authorized synthetic push.** Only after installation, issue #40
   may perform its controlled test-mode push under verified credentials, an
   approved synthetic target list, a consequence preview, explicit
   product-owner authorization, and authenticated-human confirmation. A real
   incident or live staff notification is never part of this release test.
4. **Approved closed cohort.** Only after the pilot evidence is accepted may a
   human expand private tester membership. Ordinary staff use only the external
   TestFlight `Staff` group after its separate Beta App Review gates in the App
   Store runbook; never grant ordinary staff an App Store Connect role to make
   them internal testers. Record a new audience digest, preview, approval, and
   provider read-back. Android remains on the approved Play `alpha` group.

Stop expansion on a crash, authentication failure, missing or misleading
notification state, real/drill ambiguity, unknown delivery truth, unexpected
invitation, provider drift, or incomplete evidence. Removal of access does not
uninstall a previously downloaded build; use the rollback procedure as well.

## 7. OTA eligibility and staged update policy

OTA is optional and may deliver only a reviewed JavaScript-only patch to an
already compatible runtime. When classification is uncertain, require a new
store build.

This classification is a mandatory human release review, not an automated
change classifier. The `psdEocReleasePolicy` metadata and its configuration test
keep the documented categories synchronized; they do not authorize or publish
an OTA update.

| Change                                                                                                                                                               | OTA?                                      | Required path                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| Copy, layout, style, or JavaScript bug fix using the existing native modules, permissions, API contract, and persisted-data shape                                    | Eligible after verification-channel proof | Staged OTA below                                          |
| Push registration, token lifecycle, payload handling, foreground/background/killed behavior, notification channels, sounds, or entitlements                          | No                                        | New store build and app version                           |
| OIDC, sessions, SecureStore, biometrics, deep-link authentication, or authorization behavior                                                                         | No                                        | New store build and app version                           |
| Native code, Expo/RN SDK, dependency or config-plugin change, permission, entitlement, scheme, app identifier, native asset, build property, or environment contract | No                                        | New store build and app version                           |
| `expo-updates`, update URL/channel, runtime policy, persistent-data compatibility, or native/JS contract                                                             | No                                        | New store build and app version                           |
| Start-event confirmation, human-only action boundary, real/drill classification, or live-provider gate                                                               | No, even if JavaScript-only               | New store build and app version plus safety-path evidence |

The `ota-preview` build profile deliberately uses the `production` EAS
environment while subscribing only to the dedicated `ota-verification` update
channel. The ordinary `preview` profile stays on its distinct `preview` channel
and environment. This prevents a production-configured verification bundle
from reaching ordinary preview builds that share the same app-version runtime.
Do not promote a bundle created with the ordinary `preview` profile or
`preview` EAS environment. If update code signing is introduced, stop until
the `ota-preview` and production verification configuration is proven
identical and recorded.

An `ota-preview` artifact is an internal-distribution build, not a harmless
local preview. Apply the INTERNAL BUILD ACCESS gate above in full. Because it
uses the production application name, identifier, API origin, and compiled
push-registration setting, install it only on product-owner-approved dedicated
non-operational verifier devices that are never carried or relied upon during a
real operation. It must never replace the store build on an operational device.
Before replacing an existing app, place the device out of operational reliance,
sign out while online, and obtain exact token-free session-revocation and push-
unregistration evidence. Missing or indeterminate cleanup keeps the device
quarantined; do not uninstall merely to hide the uncertainty. Before a verifier
device returns to an operational or ordinary test cohort, sign out online and
confirm cleanup again, remove `ota-preview` and temporary artifact access,
reinstall the exact approved TestFlight or Play build through that store (not
from an internal URL or backup), and read back the store build identity,
`production` update routing, and perform **LAUNCHED IDENTITY READ-BACK** with
`APPROVED_CHANNEL` set to `production` after the second online cold launch.
Prove the old internal endpoint is inactive and the current store endpoint is
the only expected active endpoint. Removal alone does not prove a store
reinstall; missing or ambiguous re-entry evidence keeps the device out of
service.

Before each `ota-preview` build, perform the same complete channel, branch, and
platform/runtime update inventory described in section 2, substituting
`ota-verification` for `production`. The fresh BUILD preview must state whether
EAS will create and link that exact same-name channel and branch. Existing
unexpected routing or a compatible update that is not already bound to the
reviewed verification plan blocks the build. Required signing credentials,
including every iOS device and provisioning profile, must already exist.
Because the first build for a platform can initialize its remote native-version
counter even though `ota-preview` does not auto-increment, read back the counter
with `build:version:get --profile ota-preview` before and after the attempt and
include a possible initialization in the exact preview. For iOS internal
distribution, also prove the selected ad hoc or enterprise provisioning mode is
unambiguous before invocation; a noninteractive selection failure can occur
only after version/routing mutation:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 build:version:get --platform ios --profile ota-preview --json
bunx eas-cli@21.7.0 build:version:get --platform android --profile ota-preview --json
bunx eas-cli@21.7.0 build --platform ios --profile ota-preview \
  --non-interactive --freeze-credentials
bunx eas-cli@21.7.0 build --platform android --profile ota-preview \
  --non-interactive --freeze-credentials
```

After success, refusal, or partial failure, rerun both `build:version:get`
commands and reread the exact credential, routing, compatible-update, build,
source-upload, and quota/cost inventory. Stop on any change beyond an approved
`{}` to `1` initialization or same-name creation/link; an existing numeric
counter must not change because `ota-preview` has no auto-increment. Immediately
before opening
an install page, installing the artifact, or launching it for verification,
reread the access setting, approved audience digest, channel mapping, and
compatible updates. A URL alone is never privacy, audience, install, or
launched-bundle evidence.

Immediately before an OTA preview or publication, repeat both production EAS
scope inventories and the two-variable `env:exec` proof above. The effective
API origin and push-registration switch must exactly match the immutable values
recorded for the installed production and `ota-preview` binaries. A change to
either compiled value is an environment-contract change and therefore requires
a new app version and store build; it is never eligible for OTA. Environment
drift, even with no Git diff, blocks publication.

Resolve both `ota-preview` platforms against that same production environment
before its BUILD; do not infer their compiled values from the production
profiles:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 config --platform ios --profile ota-preview --json
bunx eas-cli@21.7.0 config --platform android --profile ota-preview --json
```

Every destination OTA routing pair must already exist before its write. Except
for the paused-containment rollback path in section 8, the destination channel
must also be active. In EAS CLI 21.7.0, each of these can create or link routing
when its destination is absent: `update --channel ota-verification`, `update:republish
--destination-channel production`, and `update:roll-back-to-embedded --channel
production`. Do not use that implicit mutation. The immediate preflight must
prove the canonical unconditional raw `branchMapping`: version `0`, exactly one
data entry, that entry's `branchMappingLogic` exactly `"true"`, and its
`branchId` equal to the exact same-name branch ID. Ordinary verification
publication, production republish, and rollout increases also require the exact
destination channel to report `isPaused: false`; the section 8 rollback
exception instead requires a known unchanged pause status. A missing channel,
missing or orphaned branch, unknown channel state, conditional mapping, zero or
multiple mapping entries, different branch ID, partial state, or indeterminate
page blocks every command. A paused channel additionally blocks every
non-rollback command. Establish an absent pair only through the separately
previewed BUILD consequence. Unpause or remap a channel only through a separate
routing mutation with its own exact preview, explicit product-owner approval,
fresh authenticated-human confirmation, and complete read-back. In either case,
repeat the complete inventory before publishing. An OTA approval never
authorizes channel or branch creation, linking, rerouting, pausing, or
unpausing.

For an eligible patch:

1. Record the exact clean commit, current runtime, known-good update group, and
   rollback compatibility. Run the full gate and the private-access/routing
   preflight above. Build and install an exact `ota-preview` binary for that
   runtime; verify its resolved profile, Git commit, application identifier,
   update channel, production environment, and launched embedded/update
   identity. In the same uninterrupted authenticated physical-device session,
   perform **LAUNCHED IDENTITY READ-BACK** with `APPROVED_CHANNEL` set to
   `ota-verification`. The screen is read-only: it never checks, fetches,
   downloads, reloads, selects, or publishes an update and exposes no manifest,
   log, API URL, session, device, user, or recipient data. Any stop condition in
   that source-aware procedure blocks publication.

2. After human approval, publish to `ota-verification` using the production
   environment explicitly. Record the returned immutable verification
   update-group ID:

   ```sh
   cd packages/mobile
   bunx eas-cli@21.7.0 update \
     --channel ota-verification \
     --platform 'APPROVED_PLATFORM' \
     --environment production \
     --message 'APPROVED_VERIFICATION_REFERENCE' \
     --non-interactive
   bunx eas-cli@21.7.0 update:view \
     'EXACT_VERIFICATION_UPDATE_GROUP_ID' --json
   ```

   Before and after the device test, reread the complete `ota-verification`
   mapping and compatible-update inventory and require it to bind the same
   exact group. Test that group on physical `ota-preview` builds. With
   `checkAutomatically: ON_LOAD` and `fallbackToCacheTimeout: 0`, the first
   online cold launch normally starts the check and download without delaying
   the cached or embedded launch; fully quit and cold-launch again to adopt the
   downloaded update. Network or offline conditions can delay adoption beyond
   two launches, so record the exact update-group identity and observed safe
   behavior on every required device; otherwise adoption remains `unknown`.
   A synthetic notification test still requires a freshly confirmed human
   action and every live-provider prerequisite; publishing an update never
   authorizes a send.

3. Before previewing the 10% production rollout, use the complete production
   inventory to identify the exact latest update ID that EAS CLI 21.7.0 will
   select as the control for the approved platform/runtime. Run `update:view`
   on that update's full group and require exactly one update total matching the
   approved platform/runtime, `production` branch, and reviewed known-good
   source. Authoritative raw channel/dashboard state must additionally prove
   every proposed control member is an ended non-rollout with
   `rolloutControlUpdate` absent, and that proof must agree with immutable
   post-completion evidence. A mixed-platform, still-rollout-linked, nested-
   control, or indeterminate control group blocks rollout creation because a
   later revert republishes the full control group and can reject a nested
   control only after deleting the bad rollout. If no latest compatible control
   exists, bind the exact one-platform installed embedded artifact and its
   LAUNCHED IDENTITY READ-BACK as the reviewed fallback.

   Preview production consequences, including exact source update group,
   runtime, initial exposure, and that exact control update/group or embedded
   fallback. Obtain fresh product-owner approval.
4. Republish that exact tested group to `production` at 10%; do not rebuild from
   a branch or mutable working tree:

   ```sh
   cd packages/mobile
   bunx eas-cli@21.7.0 update:republish \
     --group 'EXACT_VERIFICATION_UPDATE_GROUP_ID' \
     --destination-channel production \
     --platform 'APPROVED_PLATFORM' \
     --rollout-percentage 10 \
     --message 'APPROVED_RELEASE_REFERENCE' \
     --non-interactive
   ```

5. Record the new production update-group ID. The immediate raw
   `channel:view production --json` read-back must prove each new member's
   `rolloutControlUpdate` ID/group exactly equals the preapproved control, or
   that the control is uniformly absent for the preapproved embedded fallback.
   Any mismatch blocks exposure and expansion and invokes the already reviewed
   safe rollback or fix-forward plan.

   After each PO-defined observation window and evidence review, a human may
   advance that exact immutable group to 25%, 50%, then 100%:

   ```sh
   bunx eas-cli@21.7.0 update:edit \
     'EXACT_PRODUCTION_UPDATE_GROUP_ID' \
     --rollout-percentage 'APPROVED_PERCENTAGE' \
     --non-interactive
   bunx eas-cli@21.7.0 update:view \
     'EXACT_PRODUCTION_UPDATE_GROUP_ID' --json
   ```

   Each increase needs a fresh preview, approval, confirmation, and read-back.
   Do not start another rollout while one is active.

`APPROVED_PLATFORM` is a deliberately non-runnable placeholder. Replace it with
exactly `ios` or `android` only after the preview binds that one platform; never
use or approve `all`. Publish and republish separately for the other platform,
with a separate consequence preview, approval, confirmation, resulting group,
and read-back. `update:edit` has no platform flag, so its exact group must first
be proven by `update:view` to contain only the one approved platform; a mixed or
indeterminate group blocks the edit.

Immediately before every OTA write, capture a fresh complete paginated channel,
branch, destination-channel/branch, and both-platform exact-runtime update
inventory. Retain the complete `update:list` rollout summaries, the raw
`channel:view --json` latest-group percentage/control references, and
`update:view` every relevant group's exact members and source. Execute exactly
one mutation per approval. Treat command output only as provisional provider
acceptance, never current-state proof. Success requires these exact independent
read-backs:

- `update`: exactly one new verification group with the approved one platform,
  runtime, Git commit/digest, and message;
- `update:republish`: exactly one new production group matching the approved
  source, one platform, runtime, and rollout percentage;
- `update:edit`: no new group and only the approved percentage changed on the
  exact single-platform group.

The `update:edit` percentage claim comes from the repeated complete
`update:list` and raw `channel:view --json` read-backs; `update:view --json`
cannot prove it.

For all three write families, success also requires zero routing drift: the
pre-existing destination channel must retain its exact reviewed pause status
and the same version-0, one-entry, unconditional-`"true"` mapping to the reviewed
branch, and no channel or branch may have been created, linked, relinked,
repaired, paused, or unpaused. For ordinary verification publication,
production republish, and rollout increases, that unchanged status must be
active (`isPaused: false`).

After every OTA mutation in this section—including `update`,
`update:republish`, and `update:edit`—and after success, error, interruption, or
timeout, perform an independent complete paginated read-back of channels,
branches, the exact destination channel and branch, and platform/runtime update
inventory. Repeat raw `channel:view --json` and complete paginated
`update:list`, then run `update:view` for every resulting or compatible group,
not only the expected group. Append every immutable update ID, group ID, runtime,
source commit/digest, platform, rollout percentage/control linkage, and any
partial or `unknown` result to the release record. Command completion is never
sufficient. Any unapproved group, routing change, second-platform mutation,
missing page, stale latest group, or indeterminate state blocks device testing,
exposure, another mutation, and final acceptance.

## 8. Rollback

Rollback is a human decision. First stop rollout expansion and preserve the
bad build/update identifiers and evidence; append corrections rather than
rewriting history.

The same cold-launch behavior applies to rollback. On an online device, one
cold launch normally obtains the rollback update or directive and the next
cold launch adopts it. Offline or interrupted devices can remain on the bad
bundle longer. Publishing a rollback and completing the first launch are not
device-adoption proof: verify the known-good behavior and exact update identity
after the second cold launch, and retain `unknown` for every device without
that evidence.

For a partial OTA rollout, revert the exact rollout so clients return to its
control update. For a completed rollout, republish the exact compatible
known-good update group to `production`. If no compatible known-good OTA exists,
publish a rollback directive to the embedded bundle for the exact runtime:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 update:revert-update-rollout \
  --group 'EXACT_BAD_PRODUCTION_UPDATE_GROUP_ID' \
  --message 'APPROVED_ROLLBACK_REFERENCE' \
  --non-interactive

bunx eas-cli@21.7.0 update:republish \
  --group 'EXACT_KNOWN_GOOD_UPDATE_GROUP_ID' \
  --destination-channel production \
  --platform 'APPROVED_PLATFORM' \
  --message 'APPROVED_ROLLBACK_REFERENCE' \
  --non-interactive

bunx eas-cli@21.7.0 update:roll-back-to-embedded \
  --channel production \
  --platform 'APPROVED_PLATFORM' \
  --runtime-version 'EXACT_RUNTIME_VERSION' \
  --message 'APPROVED_ROLLBACK_REFERENCE' \
  --non-interactive
```

Use only the one command matching the reviewed incident. `useEmbeddedUpdate`
is enabled and anti-bricking measures remain enabled, but a directive still
requires connected clients to check for an update. Expect an offline long tail.
Never republish across runtimes. If an update made persisted state
backward-incompatible, do not roll back blindly; fix forward with reviewed
compatibility handling.

The no-implicit-routing and canonical-mapping rules in section 7 apply to every
rollback command. The exact `production` channel must have a known pause status
and the canonical unconditional raw mapping to the exact same-name branch as
reviewed. A known active channel may remain active during rollback. If an
authenticated human separately paused the channel to contain the bad rollout,
keep `isPaused: true` throughout the rollback command and its complete
independent read-back; do not unpause first. Missing, unknown-status,
conditional, partial, multiple, unexpected, or indeterminate routing blocks
rollback instead of being created, repaired, remapped, or unpaused by the
command. A paused rollback succeeds only when the repaired update/control state
is proven while the channel remains paused. Exposing that repaired state then
requires a separate unpause consequence preview, explicit product-owner
approval, fresh authenticated-human confirmation, and complete read-back.

Replace `APPROVED_PLATFORM` with exactly `ios` or `android`; never use `all`.
Rollback each platform through a separately previewed, approved, confirmed, and
read-back mutation. `update:revert-update-rollout` has no platform flag, so
before invoking it, the raw `channel:view production --json` latest-group
record must prove the exact bad group is the current active rollout on the
canonical `production` branch, with the exact percentage, one approved
platform/runtime, and a determinate `rolloutControlUpdate` state for every
member. The linkage must equal the immutable link recorded immediately after
rollout creation. `update:view` must independently return exactly one update
total for that bad group. Raw channel view returns only the latest group overall
per branch, not the latest group per platform. If it no longer exposes the bad
group, use an approved read-only EAS dashboard/provider inventory that exposes
that exact active group's percentage and control references; if neither source
does, block rather than infer from `update:view` or `update:list`.

If a control reference exists, collect every distinct
`rolloutControlUpdate.group` from that exact authoritative rollout record,
then run `update:view` on every referenced full control group. Each must contain
exactly one update total and match the same approved platform, runtime,
`production` branch, and reviewed known-good source. The same authoritative
raw/dashboard evidence, corroborated by immutable post-completion evidence,
must prove every referenced control member is an ended non-rollout with
`rolloutControlUpdate` absent. A mixed/extra, still-rollout-linked, nested-
control, or indeterminate control group blocks: EAS CLI 21.7.0 republishes every
platform in each full control group, even when the bad rollout group itself is
single-platform, and otherwise can delete the bad group before rejecting a
nested control. If no control reference exists, require it to be absent for
every bad-group member; the command's fallback embedded directives must then be
limited to the one platform in the proven bad group. Mixed, missing, stale, or
indeterminate control linkage blocks.

A group ID is not inherently single-platform. This operation is non-atomic: it
deletes the entire rollout group first, then republishes the full referenced
control groups or publishes embedded directives for the bad group's platforms.
Every fan-out identity and consequence must be included in the exact preview.

After any rollback command succeeds, errors, times out, or is interrupted,
repeat the raw channel view, complete paginated update list, branch inventory,
and `update:view` reconciliation required in section 7 for every compatible or
resulting group. Append partial and `unknown` truth; never blindly retry. For
`update:revert-update-rollout`, prove the old rollout is no longer active and
bind every exact replacement control or embedded-directive group and all
resulting update IDs. For republish or embedded rollback, bind the exact new
group/directive and prove no other platform or runtime changed. Any missing,
extra, mixed-platform, partially applied, or indeterminate result blocks device
verification and every later mutation. Then verify the exact launched identity
after the second online cold launch by performing **LAUNCHED IDENTITY
READ-BACK** with `APPROVED_CHANNEL` set to `production` in the same
uninterrupted authenticated physical-device session. This applies whether the
result is a downloaded control/republished update or the installed binary's
embedded bundle. Provider read-back alone is not device adoption.

For a bad store build, stop new membership or Play draft completion, detach the
bad TestFlight build when safe, and restore the known-good closed-test build.
Stores do not permit reuse or decrement of native build numbers and cannot
force-remove an installed build. If a replacement is needed, rebuild the
known-good source as a new app version with newly incremented native numbers,
then repeat exact-build submission and staged evidence. Record what remains
installed and communicate the manual update step through approved human
channels.

## 9. FINAL ACCEPTANCE human evidence — currently BLOCKED

These records deliberately remain blocked until humans perform the external
steps. Do not replace them with mock, simulator, build-success, upload, or
provider-processing evidence.

### iOS internal TestFlight install

- Status: **BLOCKED — App Store Connect not connected, no finished iOS
  production build, and no human install evidence recorded**
- Exact EAS build ID: `BLOCKED`
- Exact App Store Connect build ID/version/build number: `BLOCKED`
- `District Technology` group read-back: `BLOCKED`
- Post-second-cold-launch embedded/update identity and matching routing
  read-back: `BLOCKED`
- Physical device/OS and fresh-install timestamp: `BLOCKED`
- Human verifier role and non-sensitive evidence link: `BLOCKED`

### Android Play alpha install

- Status: **BLOCKED — no finished Android production build and no human install
  evidence recorded**
- Exact EAS build ID and AAB digest: `BLOCKED`
- Play `alpha` release/version code and active closed-test status: `BLOCKED`
- Approved tester-group digest/count read-back: `BLOCKED`
- Post-second-cold-launch embedded/update identity and matching routing
  read-back: `BLOCKED`
- Physical device/OS and Play-install timestamp: `BLOCKED`
- Human verifier role and non-sensitive evidence link: `BLOCKED`

### Non-engineer guide walkthrough

- Status: **BLOCKED — walkthrough not recorded**
- Verifier role, platform, guide commit, and date: `BLOCKED`
- Steps completed without author assistance: `BLOCKED`
- Accessibility or wording gaps and follow-up issue links: `BLOCKED`

### Approval and final acceptance

- Status: **BLOCKED — product-owner sign-off not recorded**
- Exact consequence-preview and approval references: `BLOCKED`
- Issue #23 repository evidence: [mobile push evidence](../evidence/issue-23-mobile-push.md)
- Issue #38 repository automation: [merged PR #56](https://github.com/psd401/psd-eoc/pull/56)
- Issue #37/#40 provider and physical-device evidence links: `BLOCKED`
- Integration truth-register review: `BLOCKED`

Only the responsible human may replace a `BLOCKED` value with contemporaneous,
non-sensitive evidence. Product-owner sign-off is never inferred or supplied by
automation. This human-only FINAL ACCEPTANCE record does not itself authorize
go-live, production deployment, provider configuration, a real incident, a real
notification, an all-clear, or closing a real event.
