# Amazon SES setup and verification

This runbook covers the human-operated setup for the PSD EOC transactional
email identity in AWS account `338414773271`, region `us-west-2`. The scripts
are offline previews by default. Creating the infrastructure, submitting an SES
production-access request, and sending even one verified-recipient synthetic
test are separate human decisions.

Approved read-only inventory on 2026-08-08 confirmed the target account and
region, the existing parent hosted zone, and the then-current SES account and
identity state; this runbook and these scripts do not repeat provider contact
addresses, and no returned address was added to repository files. No coding
agent deployed infrastructure, submitted a production-access request, or sent
an email while building this automation.

## Safety boundary

- These operations never start or change an incident, send a PSD EOC incident
  notification, issue an all-clear, or close an event.
- The production-access request changes SES account review state but sends no
  email. Only an authorized human may submit it.
- `--send-test` is a live provider write. It requires
  verified credentials, an explicitly approved synthetic target, product-owner
  authorization, the displayed consequence preview, and both interactive
  confirmations.
- Never use a staff roster, student address, production notification template,
  or real incident content in a test. The script accepts exactly one separately
  verified recipient and generates fixed `TEST ONLY — NO EMERGENCY` content.
- An SES `MessageId` proves provider acceptance only. It does not prove mailbox
  delivery, inbox placement, opening, or human receipt.

## What the stack manages

The CDK stack creates and retains:

- the `alerts.psd401.net` public hosted zone;
- an NS delegation record in the existing `psd401.net` Route 53 zone
  `Z2B9XR5HEMTG1R`;
- the SESv2 `alerts.psd401.net` identity and all three Easy DKIM CNAME records;
- the `mail.alerts.psd401.net` custom MAIL FROM MX and SPF records, configured
  to reject rather than silently fall back when its MX record is unavailable;
- the `psd-eoc-transactional` configuration set and its encrypted SNS event
  destination; and
- no application send permission and no SNS subscription.

Because the parent zone is already identified in the approved account, the
delegation is automatic. Do not create a second child zone or a second NS
record manually. The `AlertsHostedZoneId` and `AlertsHostedZoneNameServers`
stack outputs are review evidence, not instructions to duplicate the record.

## Human preflight: read-only inventory

Authenticate with short-lived human credentials. Before synthesis or a change
set, verify that the credentials and existing parent zone match the intended
target. These commands are read-only:

```sh
aws sts get-caller-identity
aws route53 get-hosted-zone --id Z2B9XR5HEMTG1R
aws route53 list-hosted-zones-by-name --dns-name alerts.psd401.net
aws sesv2 get-account --region us-west-2
aws sesv2 get-email-identity \
  --region us-west-2 \
  --email-identity alerts.psd401.net
```

Stop if STS does not report account `338414773271`, the parent zone is not
`psd401.net`, or an unmanaged `alerts.psd401.net` zone or SES identity already
exists. Adopt an existing resource through a separately reviewed
CloudFormation import; never create a parallel identity or delegation.

The repository scripts perform an STS check before making any SES API call.
Their `--confirm-account` and `--confirm-region` values must also match exactly
before an AWS client is constructed.

## Local proof and reviewed deployment

Synthesis and tests do not contact AWS and do not prove that any resource was
deployed or verified:

```sh
bun install
bun run --cwd infra synth
bun run check
```

Do not deploy from this runbook without explicit product-owner approval. The
authorized human must review the CloudFormation change set, including the
automatic parent-zone delegation and SES provider configuration, before using
the documented CDK deploy procedure in `infra/README.md`. A successful stack
deployment still does not prove DKIM verification, production access, or email
delivery.

## Production-access request

The no-argument command is an offline preview and constructs no AWS client:

```sh
bun scripts/ops/ses-production-access.ts
```

An authorized human can inspect account state without mutation:

```sh
bun scripts/ops/ses-production-access.ts \
  --check \
  --confirm-account 338414773271 \
  --confirm-region us-west-2
```

The read-only check reports the SES production-access, sending, and review
states. An already-granted result is accepted only when all three agree:
production access enabled, sending enabled, and review status `GRANTED`.
`PENDING` is a no-op, `DENIED` fails closed, and only an initial or `FAILED`
review can proceed.

To submit, the authorized human supplies the approved contact address at
runtime. Do not put it in this repository, shell scripts, fixtures, or the
runbook:

```sh
bun scripts/ops/ses-production-access.ts \
  --submit \
  --confirm-account 338414773271 \
  --confirm-region us-west-2 \
  --contact-email 'APPROVED_CONTACT_ADDRESS_AT_RUNTIME'
```

The placeholder above intentionally fails validation. Replace it only in the
human's terminal. The script refuses CI and non-interactive execution, shows a
redacted consequence preview, and requires this exact phrase:

```text
SUBMIT SES PRODUCTION ACCESS REQUEST
```

Success means only that `PutAccountDetails` returned and the request was
submitted. Wait for AWS to grant the request, then confirm it with the
read-only `--check` command. Never describe submission as approval.
If an API error occurs after confirmation, the submission outcome is unknown:
do not retry until the read-only check resolves the account and review state.

## Identity and DKIM verification

After the approved deployment and DNS propagation, run the read-only readiness
check:

```sh
bun scripts/ops/ses-verification.ts \
  --check \
  --confirm-account 338414773271 \
  --confirm-region us-west-2
```

Readiness requires all of the following:

- account sending is enabled;
- the domain identity has `SUCCESS` verification and is verified for sending;
- DKIM signing is enabled and DKIM status is `SUCCESS`;
- `mail.alerts.psd401.net` has MAIL FROM status `SUCCESS`; and
- `psd-eoc-transactional` is the identity's default configuration set.

Read-only inventory on 2026-08-08 confirmed that this account had production
access. The script nevertheless requires the exact recipient to be a separately
verified email identity, imposing a stricter sandbox-style recipient
restriction for every synthetic test. That restriction does not make the
provider context a sandbox, and the consequence preview displays the live
production-access state.

## One approved verified-recipient synthetic test

This step is optional and must not be run merely because the read-only check
passes. After the product owner approves one synthetic mailbox, verify that the
exact recipient address is a separate SES email identity. Then an authorized
human may run:

```sh
bun scripts/ops/ses-verification.ts \
  --send-test \
  --confirm-account 338414773271 \
  --confirm-region us-west-2 \
  --recipient 'APPROVED_VERIFIED_SYNTHETIC_ADDRESS_AT_RUNTIME'
```

The placeholder intentionally is not a usable address. The script refuses CI
and non-interactive execution, checks STS first, requires the domain/DKIM/MAIL
FROM/configuration-set readiness checks, and asks SES to confirm the exact
recipient identity is `SUCCESS` and verified for sending. It then requires:

1. `SEND TEST ONLY TO APPROVED SYNTHETIC TARGET`
2. retyping the exact recipient address

It sends one fixed plain-text test from
`verification@alerts.psd401.net` through the explicit configuration set. The
content says that it is neither a real incident nor a drill activation.
If an API error occurs after the send confirmation, the send outcome is
unknown: do not retry until provider acceptance and delivery evidence are
resolved.

Record the returned `MessageId` only as `provider-accepted`. District and
external synthetic-mailbox evidence require two separate one-recipient runs,
each with fresh authorization and both fresh confirmations. A human must then
inspect each approved mailbox, including spam placement, without adding
addresses or provider payloads to the repository.

## Integration truth

Dry-runs, mocks, synthesis, and scripts leave the Amazon SES entry in
`docs/INTEGRATIONS.md` at `mocked`. After an approved deployment with DNS and
identity evidence, a separately reviewed change may advance it to
`configured-unverified`. Only approved end-to-end evidence can justify
`live-verified`; neither API acceptance nor one mailbox observation is enough
by itself.
