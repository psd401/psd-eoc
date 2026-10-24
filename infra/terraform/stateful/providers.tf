provider "aws" {
  region = var.aws_region

  # A wrong credential must fail before it creates anything. The tenant's
  # account id is configuration, never a literal in this repository.
  allowed_account_ids = [var.aws_account_id]

  # psd-dev-standards 08 district defaults. Tags are set on the providers
  # only, so no resource in this root carries its own tag block.
  default_tags {
    tags = {
      "psd:application"         = "psd-eoc"
      "psd:data-classification" = "partner-pii"
      "psd:environment"         = var.environment
      "psd:managed-by"          = "terraform"
      "psd:owner"               = var.owner
      "psd:repo"                = var.source_repository_url
    }
  }
}

# The region of the district's SES identity, which may differ from the pool's.
# Same account guard and tags as the default provider.
provider "aws" {
  alias  = "ses"
  region = var.ses_region

  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      "psd:application"         = "psd-eoc"
      "psd:data-classification" = "partner-pii"
      "psd:environment"         = var.environment
      "psd:managed-by"          = "terraform"
      "psd:owner"               = var.owner
      "psd:repo"                = var.source_repository_url
    }
  }
}
