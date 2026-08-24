# App Store Connect and TestFlight setup

This runbook records the verified PSD EOC App Store identity and configures
private TestFlight distribution. The scripts never contain Apple credentials
or real tester data. Their default mode previews App Store Connect changes;
writes need an explicit `--apply`, bundle-ID confirmation, and confirmation of
the exact previewed plan digest.

The app identity is fixed by issue #38:

- Name: `PSD EOC`
- Bundle ID: `net.psd401.eoc`
- SKU: `PSD-EOC-IOS`
- Internal TestFlight group: `District Technology`
- External TestFlight group: `Staff`

The app record was created once and read back on 2026-08-14:

- App Store Connect provider: `372148`
- Numeric Apple ID / EAS `ascAppId`: `6801607849`
- Primary language: English (U.S.) / `en-US`
- Initial iOS version scaffold: `1.0`
- User access: Limited Access, with zero new app-specific user grants
- TestFlight inventory: no processed build, group assignment, tester, or
  invitation exists; Build Uploads records 1.0.1/build 2 as Failed

Before BUILD, a separate provider-configuration gate was previewed, explicitly
approved by the product owner for one exact write, confirmed by the
authenticated human operator, and independently read back on 2026-08-14. It
was bound to Apple Team `87DL7L9GU6`, bundle ID `net.psd401.eoc`, only the Time
Sensitive Notifications entitlement, the two existing profiles below, and the
one existing distribution certificate:

- Existing distribution certificate serial:
  `6C578391C0F8BD2C1E2E570FED205DED`
- App Store provisioning profile: `U8P2YKU4T8`; SHA-256
  `c13a2847c944d0b0f25ba007ca06142c8218d87232ad9d36d1c86726355c1fde`
- Time Sensitive Notifications is enabled for `net.psd401.eoc`; the App Store
  profile above and existing Ad Hoc profile `525SSPSUMQ` were regenerated in
  place and stored in their corresponding EAS credential configurations without
  changing the Ad Hoc device set

That gate did not create, delete, revoke, renew, or replace a certificate;
create or delete a profile; register a device; change another capability; or
authorize a build, upload, submission, tester exposure, or installation. The
repository records only this bounded, non-secret read-back; the approval
transcript, credential material, and Apple session data remain outside the
repository and are not reusable authorization. BUILD began only after that gate
completed and a later exact one-build preview received its own product-owner
approval.

That separately approved EAS iOS production BUILD then finished:

- Build:
  `e68d07aa-98e5-4c87-8595-52175975291f`, source
  `bef4d64b40508dd3ef60e4de190a53b23effce40`, app/runtime `1.0.1`, build `2`,
  IPA SHA-256
  `7c22776b959bb8f015f077b8fc73247b005b298ae97e18240d50aea77432adb9`

A separately approved upload-only EAS submission
`dcd24fd9-16ef-455d-92a8-c3852b4cfcd3` finished transport for that exact build
and App Store Connect app `6801607849`. App Store Connect Build Uploads marked
version 1.0.1/build 2 **Failed** with error 90683 because its Info.plist lacks
`NSMotionUsageDescription`. That immutable binary is not eligible for retry or
TestFlight. No processed build, group assignment, tester, invitation, or
physical installation exists. The repository correction advances the next
candidate to app/runtime 1.0.4; its replacement build and later upload require
fresh separate approvals and remain pending.

The bundle identifier already existed in the Apple Developer account, so the
app-record operation did not create or change a bundle ID or capability. App
creation used the authenticated App Store Connect interface because Apple's
official API does not create app records. Later group, tester, review, and
App Store Connect inventory automation uses the official App Store Connect
API; Apple Developer capability/profile management and EAS BUILD use their
corresponding provider services. The numeric app identity above is non-secret;
staff identities and Apple session data are not release evidence and must never
be copied here.

## 1. Human prerequisites

1. Before creating an App Store Connect API key, prepare an exact consequence
   preview that identifies the Apple team, proposed key name, least required
   role, access scope, key count, and approved custody destination. Obtain fresh
   explicit product-owner approval for that one key creation. If approval is
   absent, ambiguous, stale, or differs from the preview, stop before opening
   the creation flow.
2. After that approval, an authenticated human opens **Users and Access >
   Integrations > App Store Connect API**, verifies the previewed values, and
   generates exactly the approved team API key. Download the `.p8` file once.
3. Put the key in an approved secrets system. For a local run, materialize it
   as an owner-private regular file in an owner-private directory outside
   **every Git repository**, not merely outside this checkout. Never use a
   symlink, FIFO, device, directory, or other special file. Never copy a `.p8`,
   tester CSV, beta-review contact file, or demo credential into any
   repository.
4. Record the key ID and issuer ID. They are identifiers, not substitutes for
   protecting the private key.
5. Run the App Store Connect preview and audit scripts with the repository's
   pinned Bun toolchain. Do not substitute npm, npx, or an unpinned global
   executable. The historical creation lane pins Ruby 3.3.12 and Bundler 2.6.9.
   It remains reproducible only for a separately scoped recovery that
   explicitly authorizes it: verify them with `ruby --version` and
   `bundle _2.6.9_ --version`, then run `bundle _2.6.9_ install` from
   `scripts/ops/appstore`. Fastlane is an operations-only dependency. Do not
   install or run that lane merely to reconcile or retry the verified record.
6. Obtain explicit product-owner approval for the exact live-provider write
   before running Fastlane `produce`, EAS Submit, or any ASC `--apply`.
   Approval to create the API key authorizes neither its use nor any later
   provider write. Possessing credentials or having a prior approval is not
   authorization for a new run. If approval is absent, ambiguous, or stale,
   stop before the write.

Do not try to bypass Apple ID sign-in, two-factor authentication, API-key
generation, agreements, or Beta App Review. Those are human/Apple gates.

## 2. Verify the existing app record (read-only)

Do not run the app-creation lane again. A success, error, timeout, or interrupted
provider operation never authorizes a retry. Before any later Apple write,
read **Apps → PSD EOC → App Information** and stop unless the provider, numeric
Apple ID, name, bundle ID, SKU, primary language, and initial version match the
verified values above exactly. Also read **User Access** and TestFlight; stop if
access is broader than Limited Access, an unexpected app-specific user is
granted, or any build, group, tester, or invitation is present outside the
freshly approved plan.

The historical creation lane in `scripts/ops/appstore` requires explicit Apple
ID authentication, exact team selection, and bundle-ID confirmation. It is not
a reconciliation or retry mechanism. Any apparent conflict now requires a new
read-only investigation and separately scoped decision, not another create
attempt.

## 3. Prepare private input files

Keep the API key, tester CSVs, and beta-review JSON as owner-private regular
files in an owner-private directory outside every Git repository. The script
rejects repository-contained files, symlinks, special files, files with unsafe
permissions, and oversized inputs before using their contents. Do not weaken
these checks to accommodate a temporary-file location.

Tester CSV files accept a Google Group member export or a small CSV with any of
these case-insensitive email headers: `email`, `email address`, or
`member email`. Optional name headers are `firstName`/`first name` and
`lastName`/`last name`. Each semantic field must appear at most once, including
aliases, and every data row must have exactly the header's number of columns.
Tester inputs must never contain student or guardian rosters, contacts,
schedules, locations, or other student-level data. Every identity must be
positively established as a product-owner-approved synthetic staff-context
test account for the exact authorized run; an unknown or unclassified identity
stops the run. Never substitute a broad directory export for that reviewed
target list.
If a member-type column is present, every row must explicitly be `USER`
(case-insensitive). Blank, misspelled, `GROUP`, `CUSTOMER`, `EXTERNAL`, or any
other member type fails the entire file. Nested Google Groups are never
expanded or silently omitted: first create and human-review a flattened,
USER-only export.

Internal testers must already be App Store Connect users. External testers are
invited by TestFlight. The script only adds people; it never removes existing
testers. Apple does not allow Managed Apple Accounts in reserved domains to
test builds, so validate one intended district account before bulk enrollment.

Staff identities are never placed in App Store Connect request URLs or in
operator logs and errors. Each preview makes one bounded, paginated user-
collection read for a nonempty internal roster and one bounded, paginated
tester-collection read for each nonempty audience, using only fixed field and
page-size parameters. Apply first repeats that read-only preview, then makes
one additional fresh user-collection read before internal tester writes so a
stale confirmed transcript cannot stand in for current role and app access.
It validates every returned user or tester and matches approved email
addresses locally and case-insensitively. Valid unrelated account records are
ignored and are never assigned to an internal or external audience. A wrong-
type or malformed record, duplicate ID or email, unsafe role/access record,
pagination/resource-limit breach, or conflicting audience identity fails
closed with a count or static diagnostic rather than exposing the staff
identity. Remaining dynamic request paths contain only the fixed public app
identity or provider IDs restricted to opaque non-email characters.

Complete inventories are corroborated in the owner direction: each app, group,
or build related-resource collection must match its raw relationship linkage
exactly. Tester-side `apps`, `betaGroups`, and `builds` relationships are read
and compared exactly around each selected existing-tester link, and the only
permitted delta is addition of the target app and group with no individual
build change. A newly created tester must have exactly the target app and
group, the expected internal/external group type, and no individual builds.
For a restricted App Store Connect user, the related `visibleApps` collection
must exactly match its `visibleApps` relationship linkage. Immediately before
an internal tester link or create, the script freshly revalidates that user's
opaque ID, username, roles, `allAppsVisible` value, and access to the exact app.
It also freshly reads an existing account tester by opaque ID immediately
before linking and requires the same ID and approved email. Missing, extra,
duplicate, wrong-type, conflicting, or drifting relationship evidence fails
closed without placing an email address in the request URL or diagnostic.

Treat each CSV as a strict, approved roster for its named audience, not as a
discovery source. Review every address and the total before previewing. The
`District Technology` internal group grants App Store Connect users access to
eligible internal builds. Adding an address to the external `Staff` audience
can result in a real Apple/TestFlight invitation. If a row is malformed, an
audience is ambiguous, or the proposed app-wide audience would exceed Apple's
limit, the operation must fail closed; do not trim or reinterpret the roster
during an apply. The complete approved internal-plus-external input is also
bounded by PSD EOC's 1,200-staff product ceiling, with at most 100 internal
testers. The operation also fails closed rather than reuse an existing
group whose internal/external audience type or build-scoped access cannot be
proven. Capacity preflight inventories group, app, and individual-build tester
assignments. Because Apple does not label an individual assignment as internal
or external, every such tester must also belong to at least one typed app
group, and all of that tester's typed group memberships must agree on one
audience. Multiple memberships are permitted only when they are all internal
or all external. An ungrouped or cross-audience individual assignment stops
the operation for human reconciliation; the script never guesses, moves, or
deletes it.

Example beta-review JSON shape (fill with approved real values in a secure
temporary file):

```json
{
  "contactFirstName": "Review contact first name",
  "contactLastName": "Review contact last name",
  "contactPhone": "Review contact phone",
  "contactEmail": "review-contact@example.invalid",
  "demoAccountRequired": false,
  "notes": "How Apple can exercise the beta safely.",
  "locale": "en-US",
  "betaDescription": "PSD EOC private staff beta.",
  "feedbackEmail": "testflight-feedback@example.invalid",
  "whatsNew": "Exercise the approved scenarios for this exact build."
}
```

`betaDescription` is app-wide. `whatsNew` is the locale-specific **What to
Test** text for one exact build and must be reviewed and updated for each build
before distribution. It is written only when the command selects that exact
build; changing it changes the plan digest.

The locale must be one of Apple's exact, case-sensitive TestFlight locale
identifiers: `da`, `de-DE`, `el`, `en-AU`, `en-CA`, `en-GB`, `en-US`,
`es-ES`, `es-MX`, `fi`, `fr-CA`, `fr-FR`, `id`, `it`, `ja`, `ko`, `ms`,
`nl-NL`, `no`, `pt-BR`, `pt-PT`, `ru`, `sv`, `th`, `tr`, `vi`, `zh-Hans`,
or `zh-Hant`. Omitting `locale` selects `en-US`; explicit `null`, blank,
whitespace-padded, or differently cased values fail before any provider
request.

If sign-in is required for review, set `demoAccountRequired` to `true` and add
`demoAccountName` and `demoAccountPassword`. Keep that file out of Git and
remove the temporary copy after the run. When `notes`, `demoAccountName`, or
`demoAccountPassword` is omitted, the reviewed plan explicitly clears any
stale value already stored by Apple rather than silently preserving it.

## 4. Preview and apply groups, testers, and review metadata

Run every command in this section from the repository root; the script paths
below are root-relative.

Set credentials without printing the private key:

```sh
export ASC_KEY_ID='KEY_ID'
export ASC_ISSUER_ID='ISSUER_ID'
export ASC_KEY_PATH='/secure/temporary/AuthKey_KEY_ID.p8'
```

Possessing credentials is not authorization to send TestFlight invitations.
Development and CI use fail-closed mocks and synthetic data only; they never
authenticate to Apple or apply. An explicitly approved, human-operated setup
run may use the read-only preview below. Before any invitation-capable
`--apply`, the human operator must document all of the live-provider
prerequisites for that exact run: verified least-privilege
credentials, a product-owner-approved synthetic target list, explicit product-
owner authorization, review of the complete consequence preview and its exact
digest, and fresh human confirmation. A real staff roster is not a synthetic
target list, and this runbook does not authorize using one for a live apply.
The example CSV filenames below do not change that boundary. If any
prerequisite is absent or stale, stop after preview.

Preview group creation, tester additions, and beta metadata. App Store Connect
currently has no uploaded or processed PSD EOC build. Preview mode performs
only authenticated `GET` requests:

```sh
bun run scripts/ops/appstore/asc.ts sync \
  --internal-testers /secure/temporary/internal-testers.csv \
  --external-testers /secure/temporary/staff-testers.csv \
  --review-info /secure/temporary/beta-review.json
```

The preview prints a `planDigest` in the form `sha256:...`. Review the complete
consequence summary, including group type, exact audience, tester counts,
metadata changes, selected build, and every proposed write. Then apply with the
identical command inputs and both confirmations, copying the digest exactly:

```sh
bun run scripts/ops/appstore/asc.ts sync \
  --internal-testers /secure/temporary/internal-testers.csv \
  --external-testers /secure/temporary/staff-testers.csv \
  --review-info /secure/temporary/beta-review.json \
  --apply \
  --confirm-apply net.psd401.eoc \
  --confirm-plan 'sha256:COPY_EXACT_PLAN_DIGEST'
```

The digest binds the proposed writes to the normalized effective values parsed
from the private inputs and every piece of Apple state used by the preview,
including the exact-parent and reciprocal relationship evidence described
below. Any change that would alter an applied value or relevant Apple state
invalidates it. If apply reports a digest mismatch, stop, rerun preview, review
the new consequences, and use the new digest; never reuse or manually derive a
digest.

One confirmed apply may add or link at most 100 testers in total across both
managed groups, but the request-weighted ceiling is lower for every current
write type: at most 45 new external testers, 11 existing external links, or 9
internal writes before topology and final-audit costs reduce the prefix
further. Mixed batches use the same deterministic cost accounting. The exact
selected prefix is bounded by Apple's observed request budget and a
topology-derived reserve for complete final verification, so operators must
use the count in the preview rather than assume a fixed batch size.
When more approved testers remain, the preview identifies the exact selected
batch and the number deferred; the matching apply writes only that batch and
does not continue to build distribution, Beta App Review, or another tester
batch. A large audience therefore requires many separately confirmed batches;
there is deliberately no fixed batch-count promise. After a fully verified
batch, the human must run a fresh preview against Apple's new state, review the
new consequences and digest, obtain fresh authorization, and explicitly
confirm the next apply. The script never loops, queues, auto-resumes, or reuses
a digest between batches. Any partial or indeterminate batch stops the sequence
for manual reconciliation.

Apply also requires a current, strictly parsed Apple request-budget response.
If the budget header is missing, malformed, or insufficient for the selected
writes plus the reserved final audit, the script stops before any provider
mutation. It rechecks the decreasing budget before each tester write while
retaining the cost of every remaining selected write and the full final-audit
reserve. On a zero-tester-backlog apply, it reserves every planned group,
review-metadata, localization, notification-safety, build-distribution, and
Beta App Review stage plus the complete final audit. The live budget is checked
again at each stage and immediately before every non-tester `POST` or `PATCH`;
a missing, lowered, or malformed value prevents that mutation and all later
ones.

Apple collection and filter scoping is treated as an untrusted hint, never as
proof of ownership. Before a provider resource can affect a plan, mutation, or
success result, the script bounds the collection and validates all types,
unique IDs, and duplicates before following per-resource relationships. Every
page must carry the requested limit and one stable bounded collection total;
the terminal accumulated count must equal that total. Missing, changing, or
truncated pagination evidence fails closed. The
app's complete beta-group related inventory must match its raw relationship
linkage; each managed group is additionally proved to belong to the exact PSD
EOC app before risky use. Every Beta App Review detail and beta app
localization must point back to that app; selected and group-listed builds must
point back to it; build beta details and beta build localizations must point
back to the selected exact build. A group's related build collection must also
match its raw build-relationship linkage exactly. These checks cover planning,
the last live guards before risky writes, post-mutation readback, and final
verification. Wrong, omitted, duplicate, wrong-type, or drifting evidence
stops the next write; after Apple has already accepted a mutation, the result
is `partial` or `indeterminate`, never success.

The operation is additive and repeatable: it reuses matching groups and
testers, updates beta-review metadata only when it differs, and does not remove
anything. A `partial` or `indeterminate` apply is not safely retryable: an
Apple mutation may have succeeded even when its response could not be verified.
Stop, inspect App Store Connect, and rerun preview with the intended inputs to
learn the remaining plan. Review its fresh digest before applying only the
remaining changes. Never blindly retry the prior apply or claim an
indeterminate result succeeded.

Adding any tester may cause Apple to send a real TestFlight invitation now or
after a build is attached, even when the target group currently has no build.
The human must review that consequence for every complete approved audience.
Before a tester-write batch, the script comprehensively rechecks the target
group plus the complete app-wide tester identity, typed-audience,
individual-build assignment, and capacity inventory. Before each tester POST,
it freshly resolves the exact `PSD EOC` app identity, rechecks the affected
tester and internal-user access when applicable, and uses adjacent bounded
reads of the target group's exact settings, app parent, build set, and both
official roster-page totals. The related-resource and raw-relationship totals
must agree with the locally evolved expected count before and after the write;
missing or malformed paging totals fail closed. Every accepted tester mutation
also receives exact-identity and reciprocal-relationship readback. After the
selected prefix, final verification re-enumerates the exact related-resource
and relationship-linkage rosters and repeats the complete target-group and
app-wide audits. A same-count concurrent roster swap cannot redirect the
fixed-recipient, add-only POST and is caught by that exact final audit. The
adjacent totals are deliberately not described as exact-set proof.
Count-changing drift stops before the next write; final-audit drift stops the
batch and is reported as partial or indeterminate if Apple already accepted an
earlier mutation. Final verification never treats a later, unreviewed app
assignment as success.

## 5. EAS Submit wiring for P5.5

P5.5's committed configuration deliberately keeps iOS submission free of
credentials and distribution side effects. The complete submit profile is:

```json
{
  "submit": {
    "production": {
      "android": {
        "track": "alpha",
        "releaseStatus": "draft",
        "changesNotSentForReview": true
      },
      "ios": {
        "ascAppId": "6801607849"
      }
    }
  }
}
```

The iOS profile pins only the verified non-secret numeric `ascAppId`. It does
not prove an App Store Connect API credential, upload, TestFlight group,
tester, invitation, or physical installation. The 2026-08-14 read-only
inventory now verifies the exact App Store provisioning profile and finished
iOS production BUILD recorded above. Those facts are BUILD evidence only, not
submission authority or provider acceptance. API-key creation and SUBMIT are
separately previewed provider writes and remain blocked until explicitly
authorized.

Keep credentials in the approved EAS credential store. Never add a `.p8` path,
Apple ID, issuer, key, tester group, or other credential or recipient value to
`eas.json`. The Android draft policy is governed separately by
[the mobile release runbook](release.md); it has no effect on this Apple flow.

Do not use interactive submission to create or select an app implicitly. Do
not run the headless command below until the exact finished iOS build,
credential inventory, complete TestFlight inventory, consequence preview,
fresh product-owner approval, and authenticated-human confirmation are all
recorded. The presence of `ascAppId` is routing configuration only, never
submission authorization.

For a headless submission, materialize an approved Expo token from the approved
secrets system only for the exact, freshly human-authorized run. Here,
`headless` describes non-interactive CLI transport; it never authorizes an
unattended or CI submission, and CI must not execute this write. Expo requires
every EAS CLI command in a monorepo to run from the app directory, so start at
the repository root and change into `packages/mobile`. First use EAS's read-
only build listing to identify and review the exact finished production build.
Submit only that immutable EAS build ID:

The P5.5 `submit.production.ios` profile must not contain a `groups` field,
and the build/submit workflow must not use EAS `testflight`, `--auto-submit`,
or any other automatic TestFlight distribution. EAS Submit is authorized only
to upload the exact reviewed build. Every build-to-group relationship remains
behind the later digest-guarded ASC preview/apply flow.

An upload can become available automatically to a TestFlight group that Apple
has configured for automatic distribution. Immediately before EAS Submit, the
human must inspect **every** beta group for the exact `PSD EOC` app in App Store
Connect, not just the two managed groups. Every group must use manual build
assignment with automatic distribution disabled, every existing membership
must be within the exact product-owner-approved synthetic target list, and no
group, setting, or membership may be unknown or ambiguous. Stop before upload
on any mismatch. Recheck the same complete group/settings/membership inventory
immediately after upload and before any distribution or review step; a racing
change stops the run and requires a fresh authorization and preview.

The following legacy form is recorded only so operators can recognize and
reject it. It relies on an unpinned global executable; **do not run it**:

```text
cd packages/mobile
eas build:list --platform ios --build-profile production --status finished
```

Use only the pinned Bun commands below:

```sh
cd packages/mobile
bunx eas-cli@21.7.0 build:list --platform ios \
  --build-profile production --status finished
bunx eas-cli@21.7.0 submit --platform ios --profile production \
  --id 'EXACT_REVIEWED_EAS_BUILD_ID' \
  --non-interactive
```

Alternatively, submit one exact reviewed local artifact with
`--path '/secure/temporary/EXACT_REVIEWED_BUILD.ipa'`. Never use `--latest` for
a write-capable submission: a newer build can finish between review and upload.

EAS uploads the build to App Store Connect; it does not replace Beta App
Review or release the app publicly. Authentication comes only from the
approved, human-provisioned EAS credential store for the exact run, and the
reviewed profile selects the already verified record by `ascAppId`; no local
credential path is committed.

## 6. Select and distribute the first processed build

After EAS Submit finishes and Apple finishes processing the upload, use a
read-only preview to discover the exact newest eligible build:

```sh
bun run scripts/ops/appstore/asc.ts sync \
  --internal-testers /secure/temporary/internal-testers.csv \
  --external-testers /secure/temporary/staff-testers.csv \
  --build latest
```

The result includes `selectedBuild.id`, version, upload date, proven `IOS`
platform, audience type, encryption declaration, and internal/external beta
readiness states. The query is restricted to iOS, but the filter alone is not
trusted: the script reads the selected build's prerelease-version relationship,
requires that prerelease version to point back to the exact PSD EOC app, and
requires its reciprocal build inventory to contain the selected exact build
once with the correct type. A missing, ambiguous, duplicate, wrong-parent, or
non-iOS relationship fails closed. Record and review that exact ID. The script
refuses `latest` in apply mode so a newly processed upload cannot silently
replace the reviewed build.

The script requires Apple's internal state to be `READY_FOR_BETA_TESTING` or
`IN_BETA_TESTING` before distribution and requires
`READY_FOR_BETA_SUBMISSION` immediately before a new external review request.
Missing export compliance, compliance review, processing exceptions, or any
unknown state fails closed. `usesNonExemptEncryption` is evidence to review,
not a question the script answers: resolve any export-compliance declaration
and supporting-document request interactively in App Store Connect, then run a
fresh preview.

Preview and then apply internal distribution with the exact ID:

```sh
bun run scripts/ops/appstore/asc.ts sync \
  --internal-testers /secure/temporary/internal-testers.csv \
  --external-testers /secure/temporary/staff-testers.csv \
  --review-info /secure/temporary/beta-review.json \
  --build 'EXACT_BUILD_ID'

bun run scripts/ops/appstore/asc.ts sync \
  --internal-testers /secure/temporary/internal-testers.csv \
  --external-testers /secure/temporary/staff-testers.csv \
  --review-info /secure/temporary/beta-review.json \
  --build 'EXACT_BUILD_ID' \
  --apply \
  --confirm-apply net.psd401.eoc \
  --confirm-plan 'sha256:COPY_EXACT_PLAN_DIGEST'
```

Use the `planDigest` printed by the immediately preceding exact-build preview.
Keep both complete approved tester CSV paths identical between preview and
apply, and use the same reviewed beta-review file so **What to Test** stays
bound to the exact build. Associating the build with the internal `District
Technology` group may immediately cause Apple to send real TestFlight
invitation email. Before apply, the human must therefore recheck the exact
build, readiness and encryption evidence, **What to Test**, group, complete
approved internal audience, and invitation consequence shown by the preview.

To request the one-time external Beta App Review, first verify the review
contact, demo access, Apple-reported encryption and beta readiness evidence,
beta description, build-specific **What to Test**, and exact
`APP_STORE_ELIGIBLE` build in this complete read-only plan:

```sh
bun run scripts/ops/appstore/asc.ts sync \
  --internal-testers /secure/temporary/internal-testers.csv \
  --external-testers /secure/temporary/staff-testers.csv \
  --review-info /secure/temporary/beta-review.json \
  --build 'EXACT_BUILD_ID' \
  --submit-beta-review
```

Only after reviewing that plan should the human apply the identical inputs and
copy its exact digest:

```sh
bun run scripts/ops/appstore/asc.ts sync \
  --internal-testers /secure/temporary/internal-testers.csv \
  --external-testers /secure/temporary/staff-testers.csv \
  --review-info /secure/temporary/beta-review.json \
  --build 'EXACT_BUILD_ID' \
  --submit-beta-review \
  --apply \
  --confirm-apply net.psd401.eoc \
  --confirm-plan 'sha256:COPY_EXACT_PLAN_DIGEST'
```

Keep both complete approved tester CSV paths and every other input identical
between this preview and apply. For this external TestFlight flow, the script
requires automatic notification to be disabled (`autoNotifyEnabled: false`)
before associating the build with `Staff` or submitting it for review.
Immediately before each build relationship POST, it re-reads the exact fixed
app identity, selected build, complete localization evidence, target group,
and the complete app-wide tester identity, typed-audience, app-assignment,
individual-build-assignment, and capacity inventory. The managed internal and
external group build-ID sets come from the confirmed preview snapshot; after
Apple accepts a build relationship, the script immediately reads that group
back and requires the exact evolved set. Final verification always compares
both complete group build sets, even in a tester-only apply, so an extra,
duplicate, wrong-type, or missing build cannot be absorbed as success.
These guards ensure complete localization inventories are also rechecked before
each build is attached to either group.

Immediately before a new review request, it also re-reads the exact app/build
and beta states, notification setting, external group/roster/build set, app
and build localization inventories, review contact/access details, and the
complete app-wide tester inventory. A `filter[build]` response is never treated
as proof that a review submission belongs to the build: every returned
submission is relationship-checked against the selected exact build, and
duplicates, over-return, wrong types, or wrong relationships fail closed.
After Apple accepts a new submission, the returned resource, its live build
relationship, and a relationship-bound list readback must agree before the
apply can succeed; final verification repeats that exact submission/build
binding. Any drift stops the invitation-capable build relationship or review
POST. A failed readback after an accepted mutation is `partial` or
`indeterminate`, never success. These controls do not suppress internal
invitation email. After external approval, choosing **Notify Testers** in App
Store Connect is a separate, fresh human action: recheck the exact build,
external group, complete approved audience, and message consequences
immediately before choosing it. The script does not perform or pre-authorize
that action.

Apple performs the review. A `WAITING_FOR_REVIEW` or `IN_REVIEW` state is not
approval; a rejected build must be corrected and replaced, not reported as
configured. As with every apply, stop and reconcile in App Store Connect if the
result is `partial` or `indeterminate`; do not blindly resubmit Beta App Review.

## 7. Verification and cleanup

1. In App Store Connect, verify both group names and types.
2. For an authorized synthetic verification run, verify the intended test
   accounts are in `District Technology` and the approved synthetic tester
   addresses are in `Staff`.
3. Verify the selected build appears for the internal group. An uploaded build
   may remain in Apple's processing state before it can be assigned.
4. Verify the selected build's localized **What to Test** text matches the
   reviewed secure input.
5. If external review was submitted, record Apple's returned review state; do
   not describe `WAITING_FOR_REVIEW` as approval.
6. Delete temporary tester/review files and the materialized `.p8` copy. Keep
   the authoritative key in the approved secrets system.

No part of this flow starts a PSD EOC event or sends a PSD EOC notification.
TestFlight invitations are still real external messages, so only the human
operator may supply and apply the product-owner-approved synthetic target list
after every live-provider prerequisite above is current. Interactive Apple
authentication, two-factor authentication, agreements, review, and the later
external-distribution **Notify Testers** decision remain human actions and must
never be bypassed or automated. This runbook does not authorize a later
transition to real staff recipients.
