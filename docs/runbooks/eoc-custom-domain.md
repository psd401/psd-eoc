# `eoc.psd401.net` App Runner custom-domain recovery

## Purpose and fixed boundary

This runbook recovers public TLS for the exact exploration service without
allowing GitHub Actions to change DNS. The fixed provider boundary is:

- AWS account `<aws-account-id>` (`psd401`), region `us-west-2`;
- App Runner service
  `arn:aws:apprunner:us-west-2:<aws-account-id>:service/psd-eoc-exploration-smoke/fd60545104344bd39ae9920feef7dd5c`;
- provider URL `<app-runner-default-domain>`;
- custom domain `eoc.psd401.net`, with the `www` subdomain disabled; and
- authoritative district DNS servers
  `<internal-name-server>` (`10.0.70.76`) and
  `vmnocdcpridns01.peninsula.wednet.edu` (`10.0.70.77`).

The public domain currently has two ParentSquare A records, `<internal-address>`
and `54.221.139.169`, and presents a certificate for
`smartsites.parentsquare.com`. Treat that observation as stale until it is
re-read immediately before a district DNS change.

The workflow does not call Route53, access a district DNS server, disassociate
a domain, enable `www`, change IAM, or mutate OAuth, access, recipients,
messaging providers, notifications, or application data. Never execute or
adapt `/private/tmp/psd-eoc-domain-apply.sh`; its Route53 zone is not
authoritative for the public district domain.

## Protected read or association

Use `.github/workflows/associate-exploration-custom-domain.yml` only from an
exact reviewed commit already on `main`. Both modes require approval in the
protected `exploration-smoke` environment and authenticate with GitHub OIDC.
The workflow verifies the outer OIDC identity, assumes the existing CDK deploy
role only inside a short-lived subprocess, and verifies that the outer identity
is restored afterward.

Use `inspect-only` with the exact acknowledgement:

```text
INSPECT EOC.PSD401.NET CUSTOM DOMAIN
```

This mode calls `DescribeCustomDomains` but never calls an AWS write API. Use
`associate-if-absent` with the exact acknowledgement:

```text
ASSOCIATE EOC.PSD401.NET WITHOUT WWW
```

That mode first reads the service, active operations, and all existing custom
domains. It calls `AssociateCustomDomain` exactly once, with
`EnableWWWSubdomain=false`, only when the exact domain is absent. It fails
closed on a wrong service, non-running service, active operation, foreign or
ambiguous domain, `www` mismatch, failed/deleting association, incomplete
validation records, or identity-restoration failure. An existing exact pending
or active association is read idempotently and is never rewritten.

The protected artifact is named
`exploration-custom-domain-<source-sha>-<run-id>`. Retain its exact raw and
redacted provider responses with the run. The actionable handoff is
`district-dns-handoff.json`; it has this shape:

```json
{
  "authoritativeDistrictDnsServers": [
    "<internal-name-server> (10.0.70.76)",
    "vmnocdcpridns01.peninsula.wednet.edu (10.0.70.77)"
  ],
  "certificateValidationCnames": [
    {
      "name": "<exact App Runner validation name>",
      "status": "PENDING_VALIDATION",
      "type": "CNAME",
      "value": "<exact App Runner validation value>"
    }
  ],
  "customDomainStatus": "PENDING_CERTIFICATE_DNS_VALIDATION",
  "dnsChanged": false,
  "dnsHandoffAvailable": true,
  "domain": "eoc.psd401.net",
  "enableWWWSubdomain": false,
  "serviceArn": "arn:aws:apprunner:us-west-2:<aws-account-id>:service/psd-eoc-exploration-smoke/fd60545104344bd39ae9920feef7dd5c",
  "state": "associated-now",
  "tlsVerified": false,
  "trafficCname": {
    "name": "eoc.psd401.net",
    "type": "CNAME",
    "value": "<exact App Runner DNS target>"
  }
}
```

Do not hand-transcribe record values from logs. Download the artifact and give
the JSON file intact to the district DNS administrator.

## District DNS handoff

A district DNS administrator must re-read the authoritative zone, confirm that
the current `eoc.psd401.net` records are the intended records to replace, and
then make one reviewed change on both authoritative servers:

1. Remove only the existing `eoc.psd401.net` A records that point to the old
   ParentSquare destination.
2. Add the exact `trafficCname` from `district-dns-handoff.json`.
3. Add every exact entry in `certificateValidationCnames`.
4. Do not create a `www.eoc.psd401.net` record.
5. Confirm that the zone serial advanced and that both authoritative servers
   return the same new record set.

No AWS or repository result authorizes an automated DNS write. If the current
records differ from the recorded ParentSquare A records, or the desired CNAME
conflicts with another record at the same owner name, stop for district DNS
review instead of deleting or replacing anything.

## Verification after the district change

Only after the district confirms the DNS change may the following checks be
used as live evidence. Never use `curl -k`, `openssl -verify 0`, a hosts-file
override, or an alternate resolver to manufacture a pass.

1. Re-run the protected workflow in `inspect-only` mode. Require the exact
   service and domain, `EnableWWWSubdomain=false`, every validation CNAME, and
   App Runner status `ACTIVE`.
2. From the district network, query both authoritative servers and require the
   same traffic and validation CNAMEs:

   ```bash
   dig +noall +answer @10.0.70.76 eoc.psd401.net CNAME
   dig +noall +answer @10.0.70.77 eoc.psd401.net CNAME
   ```

3. Query at least two independent public recursive resolvers. Require the
   public result to reach the exact App Runner target from the handoff.
4. Validate hostname and trust-chain TLS with SNI:

   ```bash
   openssl s_client -connect eoc.psd401.net:443 -servername eoc.psd401.net -verify_hostname eoc.psd401.net </dev/null
   ```

   Require `Verify return code: 0 (ok)` and a certificate valid for
   `eoc.psd401.net`.

5. Read application health over the public domain without an insecure bypass:

   ```bash
   curl --fail --silent --show-error --max-time 10 https://eoc.psd401.net/api/health
   ```

   Require the canonical healthy JSON response. Then test web and mobile sign-in
   separately; successful health does not prove OIDC or user authorization.

Keep the DNS/custom-domain integration truth label `blocked` until all five
checks are recorded. Updating it to `live-verified` is a separate reviewed
change; a pending association, generated certificate, provider URL health, or
passing mock is not enough.

## Failure and rollback boundary

- If association is pending, leave it intact and correct only the exact missing
  validation records through district DNS review. Re-running association is
  not a retry mechanism.
- If App Runner reports a failed, deleting, duplicate, or foreign association,
  stop. This workflow has no disassociate or replacement path.
- If TLS becomes valid but application health fails, keep the certificate
  records and investigate the App Runner service. Do not point traffic at a
  different unreviewed target.
- Any DNS rollback is a separately reviewed district DNS change based on the
  pre-change record capture. It is not performed by GitHub Actions or AWS
  Route53.
