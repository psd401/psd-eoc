# Google Cloud identity operations

This directory owns the Google Cloud identity and read-only Groups
configuration used by a deployment. Current Google OIDC and Groups readiness
lives only in the
[operational readiness register](../../docs/INTEGRATIONS.md). The portable AWS,
tenant, and direct deployment parameters are indexed in
[CONFIGURATION.md](../../docs/CONFIGURATION.md).

## Source boundaries

- Terraform files in this directory define the Google project, APIs, service
  account, and least-privilege role bindings.
- `scripts/groups-contract.ts` validates the configured staff-only group
  contract.
- `scripts/run-guarded.sh` is the only supported launcher for local cloud
  operations. It pins the operator environment, rejects executable startup
  hooks, validates the Google project and AWS caller, and refuses direct
  unguarded execution.
- Google Groups and OAuth credentials are separate. Neither belongs in
  Terraform state, shell history, source, logs, or evidence.
- A successful Terraform plan, credential read, or standalone provider check
  does not prove deployed sign-in or scheduled roster synchronization.

## Tenant values

No district identifier is checked in here. `scripts/tenant.ts` reads these
keys from the git-ignored `infra/cdk.local.json` and every guarded helper
refuses to run until each one is present and well formed:

| Key                              | Used as                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `psdEoc:gcpProjectId`            | Google Cloud project ID; roster reader is `roster-sync-reader@<id>.iam...`     |
| `psdEoc:gcpOrganizationId`       | Numeric parent organization ID                                                 |
| `psdEoc:gcpBillingAccount`       | Billing account in the 6-6-6 form                                              |
| `psdEoc:gcpTerraformStateBucket` | Main-root state bucket, created by the bootstrap root                          |
| `psdEoc:gcpTerraformAdminEmail`  | The one human Terraform administrator; its local part is the AWS SSO user name |
| `psdEoc:hostedDomain`            | Workspace domain for staff accounts, test groups, and the OAuth domain         |
| `psdEoc:applicationOrigin`       | Web OAuth origin; the redirect is `<origin>/auth/callback`                     |
| `psdEoc:iosBundleId`             | iOS bundle ID and Android package name                                         |
| `psdEoc:awsOperatorProfile`      | AWS CLI profile name in `aws.config`                                           |
| `psdEoc:awsSsoStartUrl`          | IAM Identity Center start URL in `aws.config`                                  |
| `psdEoc:awsAccount`              | AWS account that receives the handed-off credentials                           |

Both Terraform roots declare these as variables without defaults, and
`scripts/apply.ts` passes them with `-var` on every `plan` and `import`. The
main root's `versions.tf` names a deliberately unusable backend bucket;
`scripts/apply.ts` supplies the real one with
`-backend-config=bucket=<gcpTerraformStateBucket>` on every `terraform init`.
The bootstrap root keeps local state and has no backend. Copy
`aws.config.example` to the git-ignored `aws.config` and replace its profile
name, SSO start URL, and account ID with the tenant's values.

## Operator workflow

1. Read the readiness register and identify the exact boundary being changed.
2. Confirm the configured project, hosted domain, OAuth clients, staff-only
   group inputs, AWS account/region, retained secret references, and rollback
   point in the protected operator system.
3. Run only the corresponding action exposed by `scripts/run-guarded.sh`.
   Provider and secret writes require the product owner's current-session
   authorization; a read-only inventory does not authorize a later write.
4. Keep downloaded credential files outside the repository with owner-only
   permissions, then remove them through the approved secure process after the
   guarded store/readback completes.
5. Record only bounded, non-secret evidence. Update the readiness register
   only for the boundary actually proved.
