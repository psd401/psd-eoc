# Everything CI needs, none of it secret. `terraform output -json` after the
# one apply gives the values for the GitHub repository secrets docs list.

output "state_bucket" {
  description = "The bucket every other AWS root's backend names."
  value       = aws_s3_bucket.state.bucket
}

output "state_kms_key_arn" {
  description = "The key the stateful backend's kms_key_id names."
  value       = aws_kms_key.state.arn
}

output "plan_role_arn" {
  description = "The role the Terraform workflow's plan job assumes."
  value       = aws_iam_role.plan.arn
}

output "apply_role_arn" {
  description = "The role the Terraform workflow's apply job assumes from the production environment."
  value       = aws_iam_role.apply.arn
}
