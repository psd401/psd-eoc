# App Store Connect and TestFlight setup

This runbook creates the PSD EOC App Store record and configures private
TestFlight distribution. The scripts never contain Apple credentials or real
tester data. Their default mode previews App Store Connect changes; writes need
an explicit `--apply` confirmation.

The app identity is fixed by issue #38:

- Name: `PSD EOC`
- Bundle ID: `net.psd401.eoc`
- SKU: `PSD-EOC-IOS`
- Internal TestFlight group: `District Technology`
- External TestFlight group: `Staff`

App creation uses Apple ID authentication because Apple's official App Store
Connect API does not create app records. Everything after app creation uses the
official App Store Connect API.

## 1. Human prerequisites

1. In App Store Connect, open **Users and Access > Integrations > App Store
   Connect API** and generate a team API key with the least role that can manage
   TestFlight. Download the `.p8` file once.
2. Put the key in an approved secrets system. For a local run, materialize it
   to a permission-restricted temporary path outside this Git checkout. Never
   copy a `.p8`, tester CSV, beta-review contact file, or demo credential into
   the repository.
3. Record the key ID and issuer ID. They are identifiers, not substitutes for
   protecting the private key.
4. Install Ruby 3.3 and Bundler. From
   `scripts/ops/appstore`, run `bundle install`. Fastlane is a build/operations
   dependency because it supplies the supported Apple-ID-authenticated app
   creation flow; it is not an application runtime dependency.

Do not try to bypass Apple ID sign-in, two-factor authentication, API-key
generation, agreements, or Beta App Review. Those are human/Apple gates.

## 2. Create the app record (human, interactive)

Review the identifiers above, then run from `scripts/ops/appstore`:

```sh
APPSTORE_APPLE_ID='your-apple-id' \
CONFIRM_APPSTORE_CREATE='create net.psd401.eoc' \
bundle exec fastlane ios produce
```

If the Apple account belongs to more than one team, also set
`APPLE_DEVELOPER_TEAM_ID` and `APPSTORE_CONNECT_TEAM_ID`. Fastlane may prompt
for Apple ID sign-in and two-factor authentication. The lane deliberately
refuses to run without the exact confirmation string.

After the lane finishes, copy the app's numeric Apple ID from
**Apps → PSD EOC → App Information**. This is the `ascAppId` used by EAS
Submit.

## 3. Prepare private input files

Keep each file outside the repository. Tester CSV files accept a Google Group
member export or a small CSV with any of these case-insensitive email headers:
`email`, `email address`, or `member email`. Optional name headers are
`firstName`/`first name` and `lastName`/`last name`.

Internal testers must already be App Store Connect users. External testers are
invited by TestFlight. The script only adds people; it never removes existing
testers. Apple does not allow Managed Apple Accounts in reserved domains to
test builds, so validate one intended district account before bulk enrollment.

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
  "feedbackEmail": "testflight-feedback@example.invalid"
}
```

If sign-in is required for review, set `demoAccountRequired` to `true` and add
`demoAccountName` and `demoAccountPassword`. Keep that file out of Git and
remove the temporary copy after the run.

## 4. Preview and apply groups, testers, and review metadata

Set credentials without printing the private key:

```sh
export ASC_KEY_ID='KEY_ID'
export ASC_ISSUER_ID='ISSUER_ID'
export ASC_KEY_PATH='/secure/temporary/AuthKey_KEY_ID.p8'
```

Preview group creation, tester additions, and beta metadata. A new app has no
build yet. Preview mode performs only authenticated `GET` requests:

```sh
bun run scripts/ops/appstore/asc.ts sync \
  --internal-testers /secure/temporary/internal-testers.csv \
  --external-testers /secure/temporary/staff-testers.csv \
  --review-info /secure/temporary/beta-review.json
```

After reviewing the consequence summary, apply the same plan:

```sh
bun run scripts/ops/appstore/asc.ts sync \
  --internal-testers /secure/temporary/internal-testers.csv \
  --external-testers /secure/temporary/staff-testers.csv \
  --review-info /secure/temporary/beta-review.json \
  --apply \
  --confirm-apply net.psd401.eoc
```

The operation is additive and repeatable: it reuses matching groups and
testers, updates beta-review metadata only when it differs, and does not remove
anything.

## 5. EAS Submit wiring for P5.5

Issue P5.5 owns the mobile EAS configuration. Add the following fields to its
`production` iOS submit profile; do not commit the `.p8` file:

```json
{
  "submit": {
    "production": {
      "ios": {
        "ascAppId": "NUMERIC_APPLE_ID",
        "ascApiKeyPath": "/secure/temporary/AuthKey_KEY_ID.p8",
        "ascApiKeyId": "KEY_ID",
        "ascApiKeyIssuerId": "ISSUER_ID"
      }
    }
  }
}
```

For a headless submission, provide an approved Expo token through the CI
secret store and run:

```sh
eas submit --platform ios --profile production --latest --non-interactive
```

EAS uploads the build to App Store Connect; it does not replace Beta App
Review or release the app publicly. Do not commit the credential path shown in
the example when P5.5 adds the real configuration—use its approved secret
materialization mechanism.

## 6. Select and distribute the first processed build

After EAS Submit finishes and Apple finishes processing the upload, use a
read-only preview to discover the exact newest eligible build:

```sh
bun run scripts/ops/appstore/asc.ts sync --build latest
```

The result includes `selectedBuild.id`, version, upload date, and audience
type. Record and review that exact ID. The script refuses `latest` in apply
mode so a newly processed upload cannot silently replace the reviewed build.

Preview and then apply internal distribution with the exact ID:

```sh
bun run scripts/ops/appstore/asc.ts sync --build 'EXACT_BUILD_ID'

bun run scripts/ops/appstore/asc.ts sync \
  --build 'EXACT_BUILD_ID' \
  --apply \
  --confirm-apply net.psd401.eoc
```

To request the one-time external Beta App Review, first verify the review
contact, demo access, encryption answers, beta description, and exact
`APP_STORE_ELIGIBLE` build in this complete read-only plan:

```sh
bun run scripts/ops/appstore/asc.ts sync \
  --review-info /secure/temporary/beta-review.json \
  --build 'EXACT_BUILD_ID' \
  --submit-beta-review
```

Only after reviewing that plan should the human apply the identical command
with `--apply --confirm-apply net.psd401.eoc`. Apple performs the review. A
`WAITING_FOR_REVIEW` or `IN_REVIEW` state is not approval; a rejected build
must be corrected and replaced, not reported as configured.

## 7. Verification and cleanup

1. In App Store Connect, verify both group names and types.
2. Verify the intended existing App Store Connect users are in `District
Technology` and the approved staff addresses are in `Staff`.
3. Verify the selected build appears for the internal group. An uploaded build
   may remain in Apple's processing state before it can be assigned.
4. If external review was submitted, record Apple's returned review state; do
   not describe `WAITING_FOR_REVIEW` as approval.
5. Delete temporary tester/review files and the materialized `.p8` copy. Keep
   the authoritative key in the approved secrets system.

No part of this flow starts a PSD EOC event or sends a PSD EOC notification.
TestFlight invitations are still real external messages, so only the human
operator supplies and applies an approved tester list.
