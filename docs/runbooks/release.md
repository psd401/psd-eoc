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
application identifier, app version/runtime, public API origin, expected cost,
EAS remote build-number increment, and the complete pre-build update-routing
state. Before an authorized human starts it:

- [ ] Read-only EAS production-environment evidence shows exactly one
      `EXPO_PUBLIC_PSD_EOC_API_BASE_URL` set to the public, non-secret origin
      `https://eoc.psd401.net`. The resolved iOS and Android production build
      profiles contain that exact value; absence, another origin, a
      credential/query/path fragment, or a conflicting account-level value
      blocks the build.
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
      and runtime. An absent channel or branch, an unexpected mapping, an
      unreviewed compatible update, an indeterminate rollout, or incomplete
      pagination is recorded explicitly and fails closed.
- [ ] The preview states that BUILD creates the exact EAS artifact and, only
      when the inventory proves them absent, may create and link the exact
      same-name `production` channel and branch. It does not submit, assign a
      group, invite a tester, publish an OTA, expose a build, or authorize any
      PSD EOC notification.

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
      inventory. Bind the expected launched identity to the reviewed embedded
      build when no compatible update exists, or to one separately reviewed
      update group, source commit/digest, and determinate rollout. Any drift,
      unknown device identity, compatible unreviewed update, or indeterminate
      selection blocks exposure evidence and final acceptance.
- [ ] Tester exposure authorizes installation only. It does not authorize a
      PSD EOC notification, a real incident, or ordinary-staff expansion.

After installation, any controlled synthetic push is a separate issue #40
action. It requires verified credentials, an approved synthetic target list, a
consequence preview, explicit product-owner authorization, and authenticated-
human confirmation. Use test mode only; never start a real incident or send a
live staff notification, and prove the real-versus-drill display remains
unambiguous.

### FINAL ACCEPTANCE

FINAL ACCEPTANCE is a read-only evidence decision, not a provider-write
authorization. It requires exact physical TestFlight and Play install
identities/read-backs, the launched embedded-build or OTA-group identity after
the second online cold launch, the non-engineer guide walkthrough, issue #37's
durable Play evidence, issue #40's separately authorized controlled
physical-push evidence, integration truth labels that claim only what is
proven, and explicit human product-owner acceptance. If an installed app cannot
expose its launched update identity through approved device diagnostics, retain
`unknown`; a provider inventory alone is not device-adoption proof.

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
then prove the effective public API origin and resolve both production profiles.
The project scope must contain exactly one plaintext string variable with the
expected value and the account scope must contain no variable of the same name.
`env:exec` proves the value produced by EAS precedence without printing it;
`config` alone does not prove the variable's source or value. Do not use
`--include-sensitive` or a file variable, and do not copy the full output into
a public record:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 env:list production --scope project --format long
bunx eas-cli@21.7.0 env:list production --scope account --format long
env -u EXPO_PUBLIC_PSD_EOC_API_BASE_URL bunx eas-cli@21.7.0 env:exec production \
  'test "$EXPO_PUBLIC_PSD_EOC_API_BASE_URL" = "https://eoc.psd401.net"' \
  --non-interactive
bunx eas-cli@21.7.0 config --platform ios --profile production --json
bunx eas-cli@21.7.0 config --platform android --profile production --json
```

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
increasing iOS build numbers and Android version codes. Never edit a number to
reuse an already uploaded store identity. Record EAS's resolved values after
each build; the Git repository does not contain those remote counters.

Before a build, enumerate every page of channels and branches, then bind the
exact channel, its linked branch, and every compatible update for the target
platform and runtime. Replace each `OFFSET` with successive offsets until the
returned page is empty; retain a non-sensitive digest of the complete
inventory. An absent `production` channel/branch means EAS Build may create and
link that same-name routing as part of the separately approved BUILD
consequence. Existing unexpected routing or any compatible update whose source,
rollout, and expected launch identity are not proven blocks the build:

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

`update:list` is only a group-level summary. Run `update:view` for every
compatible group and bind every platform update ID, runtime, source
`gitCommitHash`, rollout state, and message; an unreadable or incomplete group
blocks BUILD and exposure.

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
failure and append the result. The only allowed change is the exact increment
in the approved preview; an unexpected value or indeterminate read-back blocks
all later gates.

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
local preview. By default, possession of an EAS internal-build URL can be
enough to open its installation page and Android artifacts are directly
installable. Before creating or sharing one, an authorized human must use the
exact `peninsula-school-district/psd-eoc` project settings to read back that
**Unauthenticated access to internal builds** is disabled. Reconcile the
project-member inventory and roles to one product-owner-approved, bounded,
staff-only technical-verifier audience; record only its digest and count. Any
unknown member, student or guardian, overly broad role, inability to prove the
setting, or stale audience blocks the build and install. Never put an internal
build URL in the repository, issue, PR, or other public evidence.

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
version initialization and same-name creation/link. Immediately before opening
an install page, installing the artifact, or launching it for verification,
reread the access setting, approved audience digest, channel mapping, and
compatible updates. A URL alone is never privacy, audience, install, or
launched-bundle evidence.

For an eligible patch:

1. Record the exact clean commit, current runtime, known-good update group, and
   rollback compatibility. Run the full gate and the private-access/routing
   preflight above. Build and install an exact `ota-preview` binary for that
   runtime; verify its resolved profile, Git commit, application identifier,
   update channel, production environment, and launched embedded/update
   identity. If device diagnostics cannot prove that identity, retain
   `unknown` and do not advance.
2. After human approval, publish to `ota-verification` using the production
   environment explicitly. Record the returned immutable verification
   update-group ID:

   ```sh
   cd packages/mobile
   bunx eas-cli@21.7.0 update \
     --channel ota-verification \
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

3. Preview production consequences, including exact source update group,
   runtime, initial exposure, and rollback target. Obtain fresh product-owner
   approval.
4. Republish that exact tested group to `production` at 10%; do not rebuild from
   a branch or mutable working tree:

   ```sh
   cd packages/mobile
   bunx eas-cli@21.7.0 update:republish \
     --group 'EXACT_VERIFICATION_UPDATE_GROUP_ID' \
     --destination-channel production \
     --rollout-percentage 10 \
     --message 'APPROVED_RELEASE_REFERENCE'
   ```

5. Record the new production update-group ID. After each PO-defined observation
   window and evidence review, a human may advance that exact immutable group to
   25%, 50%, then 100%:

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
  --message 'APPROVED_ROLLBACK_REFERENCE'

bunx eas-cli@21.7.0 update:republish \
  --group 'EXACT_KNOWN_GOOD_UPDATE_GROUP_ID' \
  --destination-channel production \
  --message 'APPROVED_ROLLBACK_REFERENCE'

bunx eas-cli@21.7.0 update:roll-back-to-embedded \
  --channel production \
  --runtime-version 'EXACT_RUNTIME_VERSION' \
  --message 'APPROVED_ROLLBACK_REFERENCE'
```

Use only the one command matching the reviewed incident. `useEmbeddedUpdate`
is enabled and anti-bricking measures remain enabled, but a directive still
requires connected clients to check for an update. Expect an offline long tail.
Never republish across runtimes. If an update made persisted state
backward-incompatible, do not roll back blindly; fix forward with reviewed
compatibility handling.

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
