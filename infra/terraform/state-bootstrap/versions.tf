terraform {
  # The same line as every other AWS root, so one Terraform plans them all.
  required_version = "~> 1.16.0"

  # Local state, on purpose: this root creates the bucket every other AWS root
  # keeps its state in, so it cannot keep its own there. A person with an
  # administrator session applies it once (the one local apply the migration
  # plan allows) and keeps the state file outside the repository. It holds no
  # secret: role and bucket names, policies, and a key id.
  backend "local" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68"
    }
  }
}
