# SMS carrier registration runbook

This runbook prepares the AWS End User Messaging SMS registrations required by
PSD EOC. It does **not** enable the SMS worker or authorize a live staff send.
Registration submissions are provider-configuration writes with fees and
external review; Kris Hagel must run the explicit `--submit` commands.

Development, CI, and code review use only the default offline dry-run and
injected mocks. Never use student data, a real roster, or a real recipient list
in these files.

## Verified account facts

Read-only discovery on 2026-08-08 established the following without creating or
submitting anything:

- AWS SSO profile `psd401-prr-prod` resolves to approved account
  `<aws-account-id>`.
- The required region is `us-west-2`.
- The current API registration types are
  `US_TEN_DLC_BRAND_REGISTRATION`,
  `US_TEN_DLC_CAMPAIGN_REGISTRATION`, and
  `US_TOLL_FREE_REGISTRATION`. The issue's older
  `US_TOLL_FREE_VERIFICATION` name is not a current API type.
- A 10DLC campaign must be associated with a completed brand before it is
  submitted.
- A toll-free number must be associated before its registration is submitted.

AWS can change carrier forms. The scripts retrieve every live field definition
and reject missing, unknown, mistyped, invalid, or pattern-mismatched fields
before they create a registration. Known conditional requirements are enforced
too, including distinct `REAL INCIDENT` and `DRILL` message samples.

## Install and verify

From the repository root:

```sh
bun install --cwd scripts/ops/sms-registration --frozen-lockfile
bun run --cwd scripts/ops/sms-registration check
bun run check
```

The standalone package pins the AWS SDK clients because the root workspace does
not own this external-operations issue. Runtime dependency justification: the
typed End User Messaging and STS clients use the normal credential chain,
validate the target account, and avoid static credentials or custom request
signing.

## Prepare the private input once

Copy the documented synthetic example:

```sh
cp scripts/ops/sms-registration/registration-data.example.json \
  scripts/ops/sms-registration/registration-data.json
```

`registration-data.json`, `registration-state.json`,
`registration-state.json.lock`, and `attachments/` are gitignored inside this
directory. Confirm that `git status --short` never shows them. Do not paste the
district EIN, contact details, phone number, or uploaded evidence into an issue,
PR, log, or committed file.

Replace every synthetic value in `registration-data.json`. The example's
`documentation` section lists all business inputs required by the current
forms. Values under `brand.fields`, `campaign.fields`, and `tollFree.fields`
map directly to AWS `FieldPath` values. Each entry has exactly one of:

- `text`
- `select` (an array, even for one choice)
- `attachmentFile` (relative to `registration-data.json`)

S3 and PDF attachments are rejected because the script must inspect and
sanitize the bytes locally. Campaign evidence may be a JPEG, JPG, or PNG image
no larger than 500 KB. Toll-free `messagingUseCase.optInImage` evidence must be
PNG and no larger than 400 KB. The script checks the declared extension and
image structure, strips EXIF, comments, text, timestamps, and other non-visual
metadata, and uploads only sanitized bytes. Keep source images in the ignored
`attachments/` directory and never include recipient data.

Before submission, confirm the staff opt-in material and public policy pages
meet AWS's current readiness checklist:

- Consent is an affirmative, SMS-specific action and is not preselected or
  bundled as a condition of another service.
- The consent disclosure identifies PSD EOC and the message purpose, gives the
  expected frequency, says message and data rates may apply, links directly to
  the terms and privacy policy, and gives STOP and HELP instructions.
- The opt-in confirmation includes the PSD EOC name, frequency, rate disclosure,
  and STOP/HELP instructions. Prepare at least two distinct registration samples
  that identify PSD EOC; at least one includes an explicit `Reply STOP` opt-out
  instruction.
- The public privacy policy states that mobile opt-in data and consent are not
  shared with third parties for their own marketing or messaging.

To print AWS's current field paths, types, requirements, and display names using
read-only calls:

```sh
AWS_PROFILE=psd401-prr-prod bun scripts/ops/sms-registration/status.ts \
  --definitions brand \
  --confirm-account <aws-account-id> \
  --confirm-region us-west-2

AWS_PROFILE=psd401-prr-prod bun scripts/ops/sms-registration/status.ts \
  --definitions campaign \
  --confirm-account <aws-account-id> \
  --confirm-region us-west-2

AWS_PROFILE=psd401-prr-prod bun scripts/ops/sms-registration/status.ts \
  --definitions toll-free \
  --confirm-account <aws-account-id> \
  --confirm-region us-west-2
```

The scripts enforce the current AWS field types, required fields, lengths,
select choices, and provider-supplied regular-expression patterns before
mutation. They also enforce the known conditional requirements described above.
AWS remains authoritative, so repeat this validation immediately before the
human submission.

After filling the private file, validate each section against the live schema
without creating a registration:

```sh
AWS_PROFILE=psd401-prr-prod bun scripts/ops/sms-registration/status.ts \
  --validate-data brand \
  --confirm-account <aws-account-id> \
  --confirm-region us-west-2

AWS_PROFILE=psd401-prr-prod bun scripts/ops/sms-registration/status.ts \
  --validate-data campaign \
  --confirm-account <aws-account-id> \
  --confirm-region us-west-2

AWS_PROFILE=psd401-prr-prod bun scripts/ops/sms-registration/status.ts \
  --validate-data toll-free \
  --confirm-account <aws-account-id> \
  --confirm-region us-west-2
```

## Offline consequence previews

These commands are the development and review path. They create no AWS client,
make no AWS request, and write no local state:

```sh
bun scripts/ops/sms-registration/submit-brand.ts
bun scripts/ops/sms-registration/submit-campaign.ts
bun scripts/ops/sms-registration/submit-tollfree.ts
bun scripts/ops/sms-registration/status.ts
```

The previews show registration type, field/attachment counts, target account
and region, and the external consequence without printing business values.

## Human-only submission sequence

Before each real command:

1. Authenticate the `psd401-prr-prod` SSO profile and independently verify
   `aws sts get-caller-identity --profile psd401-prr-prod` returns account
   `<aws-account-id>`.
2. Review the redacted consequence preview and private input file.
3. Confirm product-owner authorization and expected carrier fees.
4. Run from an interactive terminal. The scripts reject CI/non-TTY execution,
   unknown flags, the wrong account or region, placeholder data, and a missing
   action phrase.

### 10DLC brand

```sh
AWS_PROFILE=psd401-prr-prod bun scripts/ops/sms-registration/submit-brand.ts \
  --submit \
  --confirm-account <aws-account-id> \
  --confirm-region us-west-2 \
  --confirm-action SUBMIT_10DLC_BRAND
```

The script retrieves the live schema, validates all input, and prepares
sanitized attachments before mutation. It then creates or reconciles the brand,
writes every field, and submits the version. Do not proceed to campaign
creation until status is `COMPLETE`. `SUBMITTED`, `AWS_REVIEWING`, `REVIEWING`,
and `REQUIRES_AUTHENTICATION` are not approval.

### 10DLC campaign

```sh
AWS_PROFILE=psd401-prr-prod bun scripts/ops/sms-registration/submit-campaign.ts \
  --submit \
  --confirm-account <aws-account-id> \
  --confirm-region us-west-2 \
  --confirm-action SUBMIT_10DLC_CAMPAIGN
```

The script validates the campaign against the live schema, verifies that the
recorded brand exists with the expected type and `COMPLETE` status, creates or
reconciles the campaign and live brand association, writes every field, and
submits the version. It does not lease a 10DLC number; number request and
association happen only after campaign approval.

### Toll-free interim path

```sh
AWS_PROFILE=psd401-prr-prod bun scripts/ops/sms-registration/submit-tollfree.ts \
  --submit \
  --confirm-account <aws-account-id> \
  --confirm-region us-west-2 \
  --confirm-action LEASE_TOLL_FREE_AND_SUBMIT
```

This command has an immediate financial consequence. It validates the complete
form and sanitized attachments first, then creates or reconciles the toll-free
registration and populates every field. Only after the form is populated does
it call `RequestPhoneNumber` with the registration ID and deletion protection,
immediately persist the returned phone-number ID, verify the live registration
association, and submit the registration. The recurring lease begins when AWS
accepts the number request, even while review is pending. International sending
and self-managed opt-out handling are not enabled.

## State, retry, and status truth

`registration-state.json` uses schema version 2 and is bound to account
`<aws-account-id>`, region `us-west-2`, registration kind, and a SHA-256 fingerprint
of the private input and sanitized attachment content. A changed target, kind,
field value, or attachment fails closed. Every idempotency token and returned
resource ID is written immediately with owner-only permissions. Preserve the
file in approved operations secret storage; never delete it to bypass a
mismatch.

A submit holds an exclusive `registration-state.json.lock`. Concurrent submit
workflows are rejected. Normal completion removes the lock. If a process
crashes, first verify it is no longer running, preserve the state file, and
reconcile all recorded AWS IDs before a human removes a stale lock.

Retries read the live registration type and version status, campaign
association, and toll-free phone association before deciding whether another
write is safe. The state records intent before the non-idempotent campaign
association and registration submission calls. If `associationAttempted` or
`submissionAttempted` remains after a crash and AWS does not yet show the
expected result, the retry fails closed instead of replaying the call. Wait for
provider consistency and reconcile manually; do not edit the marker or state
file. Once the live result is visible, the retry records success without
duplicating the write. If the state file is lost after any write, stop and
recover the IDs from AWS before running a submit script again.

Read current provider status without printing the phone number:

```sh
AWS_PROFILE=psd401-prr-prod bun scripts/ops/sms-registration/status.ts \
  --check \
  --confirm-account <aws-account-id> \
  --confirm-region us-west-2
```

Re-run this command while waiting for review. Interpret status narrowly:

- Registration `COMPLETE` means AWS reports the registration approved.
- `REQUIRES_UPDATES` or a denied version requires human review. Do not create a
  new registration to hide or bypass the feedback.
- Toll-free number `ACTIVE` describes the leased number, not carrier
  verification and not message delivery.
- Missing resources and failed reads are `unknown`; never infer approval.
- Provider acceptance of a future message is not human receipt.

Status checks print the latest registration-version status and available denial
and field feedback. Provider text is normalized, stripped of terminal control
sequences, and length-limited before display. A failed or missing provider read
is printed as `unknown`; the command continues checking other recorded
resources and then exits nonzero. Partial success never implies approval.

The integration remains `blocked` in `docs/INTEGRATIONS.md` until either the
toll-free registration or the complete 10DLC path is approved and separately
reviewed evidence supports a truth-label change. Registration never authorizes
a live notification send. Enabling SMS still requires verified credentials, an
approved synthetic target list, a consequence preview, product-owner approval,
and authenticated human confirmation in the app.

## AWS references

- [Create a registration with the AWS CLI](https://docs.aws.amazon.com/sms-voice/latest/userguide/registrations-sms-cli.html)
- [10DLC registration process](https://docs.aws.amazon.com/sms-voice/latest/userguide/registrations-10dlc-setup.html)
- [10DLC campaign form](https://docs.aws.amazon.com/sms-voice/latest/userguide/registrations-10dlc-register-campaign.html)
- [Toll-free registration process](https://docs.aws.amazon.com/sms-voice/latest/userguide/registrations-tfn.html)
- [Toll-free registration form](https://docs.aws.amazon.com/sms-voice/latest/userguide/registrations-tfn-register.html)
- [Opt-in requirements checklist](https://docs.aws.amazon.com/sms-voice/latest/userguide/registration-help-quickstart.html)
- [Registration rejection troubleshooting](https://docs.aws.amazon.com/sms-voice/latest/userguide/registration-help-rejection-troubleshooting.html)
- [Registration status truth](https://docs.aws.amazon.com/sms-voice/latest/userguide/registrations.html)
