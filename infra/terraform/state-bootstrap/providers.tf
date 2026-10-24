provider "aws" {
  region = var.aws_region

  # A wrong credential must fail before it creates anything. The tenant's
  # account id is configuration, never a literal in this repository.
  allowed_account_ids = [var.aws_account_id]

  # psd-dev-standards 08 district defaults, on the provider only.
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
