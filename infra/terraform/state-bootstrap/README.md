# AWS Terraform bootstrap

This root creates what CI needs before it can plan or apply any other AWS
Terraform root in this repository. It is phase 1 of
[the migration plan](../../../docs/terraform-migration-plan.md):

- the state bucket `psd-eoc-tfstate-<account>`: versioned, KMS-encrypted with
  the `alias/psd-eoc-tfstate` key, public access blocked, TLS only. Only the
  apply role and the break-glass roles may write a state or its lock file;
- `psd-eoc-<env>-github-terraform-plan`, a read-only role that only `main`
  assumes to plan. No pull request gets it: a pull request can rewrite the
  workflow it runs, and the stateful state the role reads holds the partner
  app-client secret;
- `psd-eoc-<env>-github-terraform-apply`, which only a job in the GitHub
  `production` environment can assume, after a reviewer approves;
- `psd-eoc-<env>-terraform-boundary`, the permissions boundary on both roles.
  It denies IAM users and keys, new roles and grants, audit and organization
  changes, any change to the CI roles, their policies, the state key or the
  bucket, and any regional call outside the pool's and the SES identity's
  regions.

The account's GitHub OIDC provider already exists and other repositories'
roles trust it, so this root reads it and never changes it. The role trust
uses GitHub's immutable subject (`repo:<owner>@<id>/<repo>@<id>`), as
psd-dev-standards 08 PR flow 4 requires.

What the apply role may change is exactly what `infra/terraform/stateful`
creates: the partner user pool and its client, Cognito's email service-linked
role, `psd-eoc-*` configuration sets and topics, `psd-eoc`-tagged KMS keys,
and the `/psd-eoc/partner-user-pool-client` secret. When the migration imports
more into that root, `permissions.tf` grows in the same pull request.

## The one local apply

A person with an administrator session applies this root once. It is the only
local apply the migration plan allows, and no agent runs it
(psd-dev-standards 08 PR flow 5). Its state stays local and outside the
repository; it holds no secret.

```sh
cd infra/terraform/state-bootstrap
cp state-bootstrap.tfvars.example /protected/path/state-bootstrap.tfvars   # then edit
terraform init
terraform plan  -var-file=/protected/path/state-bootstrap.tfvars -state=/protected/path/state-bootstrap.tfstate -out=/protected/path/bootstrap.tfplan
terraform apply -state=/protected/path/state-bootstrap.tfstate /protected/path/bootstrap.tfplan
terraform output -state=/protected/path/state-bootstrap.tfstate
```

`break_glass_role_arns` takes each role's full ARN as `aws iam get-role`
prints it. An SSO permission set's role ARN includes its
`aws-reserved/sso.amazonaws.com/<region>/` path.

## Wiring GitHub to it

The [Terraform workflow](../../../.github/workflows/terraform.yml) reads
everything tenant-specific from repository secrets, because this repository is
public:

| Secret                           | Value                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `AWS_TERRAFORM_PLAN_ROLE_ARN`    | `plan_role_arn` output                                                                                                        |
| `AWS_TERRAFORM_APPLY_ROLE_ARN`   | `apply_role_arn` output                                                                                                       |
| `TERRAFORM_STATEFUL_BACKEND_HCL` | the stateful root's `backend.hcl`: `bucket` = `state_bucket`, `kms_key_id` = `state_kms_key_arn`, the `key`, and the `region` |
| `TERRAFORM_STATEFUL_TFVARS`      | the stateful root's `stateful.tfvars`                                                                                         |
| `TERRAFORM_PLAN_PASSPHRASE`      | a random passphrase that encrypts the saved plan between the plan and apply jobs                                              |

Then create the `production` environment with both of these, which together
are the control on the apply role:

- a required reviewer. The apply job waits for that approval;
- deployment branches limited to `main`. The apply role trusts any job that
  names this environment, so without the branch rule a branch could add its
  own job naming it and reach the role once someone approved it.

The first apply needs no code change: run the workflow from `main` with
**Run workflow**. Every later change to `infra/terraform/stateful` is checked
credential-free on its pull request (`bun run verify:terraform`), then planned
on `main` after merge. The plan's summary lists each change's address and
action; the full plan, with tenant values masked, is in the run's log. The
reviewer reads it there and approves or rejects the apply. Identifiers AWS
assigns (pool and client ids, ARNs once the account id is masked) are not
secret and do appear in that public log.

## Checks

`bun run verify:terraform` runs `fmt`, `validate` and `terraform test` here
with no credential: the provider has fake keys and skips every AWS call, and
the one data source that would call AWS is overridden. The tests check both
roles' trust, the boundary, that the plan role only reads, and the state
bucket's settings and writers.
