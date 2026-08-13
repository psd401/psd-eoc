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
and EAS remote build-number increment. Before an authorized human starts it:

- [ ] Read-only EAS production-environment evidence shows exactly one
      `EXPO_PUBLIC_PSD_EOC_API_BASE_URL` set to the public, non-secret origin
      `https://eoc.psd401.net`. The resolved iOS and Android production build
      profiles contain that exact value; absence, another origin, a
      credential/query/path fragment, or a conflicting account-level value
      blocks the build.
- [ ] The signing and EAS configuration required for that platform is verified
      without placing credentials in the repository.
- [ ] The preview states that BUILD creates only an EAS artifact. It does not
      submit, assign a group, invite a tester, publish an OTA, expose a build,
      or authorize any PSD EOC notification.

After BUILD, append the immutable EAS build ID, resolved native build number,
artifact digest, status, and provider-independent read-back. Issue #37's first
manual AAB upload and issue #40's physical-device delivery consume these BUILD
artifacts; completion of #37 or #40 is not a BUILD prerequisite.

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
identities/read-backs, the non-engineer guide walkthrough, issue #37's durable
Play evidence, issue #40's separately authorized controlled physical-push
evidence, integration truth labels that claim only what is proven, and explicit
human product-owner acceptance.

Closed issues #23 and #38 establish only their recorded repository-side
automation; neither substitutes for provider or physical-device evidence.
FINAL ACCEPTANCE does not authorize a production deployment, ordinary-staff
expansion, a real incident, a real notification, an all-clear, or closing a real
event.

An old approval, a credential, a passing mock, or a successful upload is not
approval for distribution. A partial or indeterminate provider response is a
stop condition: inspect provider state read-only and create a fresh plan; never
blindly retry.

Inspect the production environment without requesting sensitive values, then
resolve both production profiles and verify the exact public API origin above.
Do not use `--include-sensitive`, and do not copy the full output into a public
record:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 env:list production --format long
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

Build only a clean, reviewed commit and never combine building with submission:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 build --platform ios --profile production
bunx eas-cli@21.7.0 build --platform android --profile production
```

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

For an eligible patch:

1. Record the exact clean commit, current runtime, known-good update group, and
   rollback compatibility. Run the full gate. Build and install an exact
   `ota-preview` binary for that runtime; verify its resolved profile, Git
   commit, application identifier, update channel, and production environment.
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

   Test that exact group on physical `ota-preview` builds. With
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
- Physical device/OS and fresh-install timestamp: `BLOCKED`
- Human verifier role and non-sensitive evidence link: `BLOCKED`

### Android Play alpha install

- Status: **BLOCKED — no finished Android production build and no human install
  evidence recorded**
- Exact EAS build ID and AAB digest: `BLOCKED`
- Play `alpha` release/version code and active closed-test status: `BLOCKED`
- Approved tester-group digest/count read-back: `BLOCKED`
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
