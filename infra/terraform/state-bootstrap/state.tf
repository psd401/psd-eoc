# The S3 bucket every other AWS root of this repository keeps its state in, and
# the KMS key that encrypts it (psd-dev-standards 08 State rules: versioned,
# KMS-encrypted, public access blocked, written only by CI and break-glass).

locals {
  state_bucket     = "psd-eoc-tfstate-${var.aws_account_id}"
  state_bucket_arn = "arn:aws:s3:::${local.state_bucket}"
  state_key_alias  = "alias/psd-eoc-tfstate"

  # Policies name the state key by its alias rather than its ARN, which is not
  # known until the key exists (KMS Developer Guide, "Use aliases to control
  # access to KMS keys").
  state_key_by_alias = { test = "ForAnyValue:StringEquals", variable = "kms:ResourceAliases", values = [local.state_key_alias] }

  # Each state this bucket holds, and who may write it besides nobody. The
  # stateful state holds the partner app-client secret, so it is
  # secret-bearing (infra/terraform/stateful main.tf).
  state_keys = {
    stateful = "psd-eoc/terraform/stateful.tfstate"
  }
  state_writer_arns = concat([local.apply_role_arn], var.break_glass_role_arns)
}

data "aws_iam_policy_document" "state_key" {
  # KMS's default key policy: the account's IAM policies decide who else may
  # use the key, so the CI roles' grants in permissions.tf apply.
  statement {
    sid       = "AccountIamDecides"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }
  }
}

resource "aws_kms_key" "state" {
  description         = "Encrypts psd-eoc's Terraform state."
  enable_key_rotation = true
  policy              = data.aws_iam_policy_document.state_key.json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "state" {
  name          = local.state_key_alias
  target_key_id = aws_kms_key.state.key_id
}

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Only the apply role and break-glass change a state or its lock file. The
  # plan role reads and plans without a lock (`-lock=false`); the apply takes
  # the lock, and Terraform refuses a saved plan whose state has changed.
  dynamic "statement" {
    for_each = local.state_keys

    content {
      sid       = "OnlyItsWritersChange${title(statement.key)}State"
      effect    = "Deny"
      actions   = ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
      resources = ["${local.state_bucket_arn}/${statement.value}", "${local.state_bucket_arn}/${statement.value}.tflock"]

      principals {
        type        = "*"
        identifiers = ["*"]
      }

      condition {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = local.state_writer_arns
      }
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json

  # S3 refuses a policy naming a principal that does not exist yet.
  depends_on = [aws_iam_role.apply]
}

# psd-dev-standards 12: the current state never expires; a year of history is
# enough to roll back.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 365
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
