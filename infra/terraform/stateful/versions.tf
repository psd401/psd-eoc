terraform {
  # Pinned to one minor line so every operator and every CI job plans with the
  # same Terraform. docs/terraform-migration-plan.md records the decision.
  required_version = "~> 1.16.0"

  # The tenant's state bucket is never committed: this repository is public.
  # The checked-in bucket name is deliberately unusable, exactly as the
  # infra/gcp roots do it, and the real bucket arrives through
  # `-backend-config=bucket=<value>` on every init of this root.
  backend "s3" {
    bucket       = "replace-with-tenant-terraform-state-bucket"
    key          = "psd-eoc/terraform/stateful.tfstate"
    use_lockfile = true
    # This state holds the partner client secret. Its KMS key arrives in
    # the protected backend.hcl together with the bucket.
    encrypt = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68"
    }
  }
}
