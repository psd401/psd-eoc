# These three values are the whole handoff to the CloudFormation stack. They
# are identifiers and an ARN; the client secret itself is never an output.
output "partner_user_pool_id" {
  description = "Partner Cognito user pool id."
  value       = aws_cognito_user_pool.partner.id
}

output "partner_user_pool_arn" {
  description = "Partner Cognito user pool ARN."
  value       = aws_cognito_user_pool.partner.arn
}

output "partner_user_pool_client_id" {
  description = "Server app-client id for the partner user pool."
  value       = aws_cognito_user_pool_client.server.id
}

output "partner_user_pool_client_secret_arn" {
  description = "Secrets Manager ARN of the server app-client credential."
  value       = aws_secretsmanager_secret.partner_client.arn
}

# The exact `cdk deploy --parameters` arguments, so nobody has to transcribe
# three identifiers by hand.
output "stack_parameters" {
  description = "CloudFormation parameter values the PsdEoc stack consumes."
  value = {
    PartnerUserPoolClientId        = aws_cognito_user_pool_client.server.id
    PartnerUserPoolClientSecretArn = aws_secretsmanager_secret.partner_client.arn
    PartnerUserPoolId              = aws_cognito_user_pool.partner.id
  }
}
