# The whole handoff to the CloudFormation stack, keyed by the stack's own
# parameter names so `cdk deploy --parameters` needs no transcription. These
# are identifiers and an ARN; the client secret itself is never an output.
output "stack_parameters" {
  description = "CloudFormation parameter values the PsdEoc stack consumes."
  value = {
    PartnerUserPoolClientId        = aws_cognito_user_pool_client.server.id
    PartnerUserPoolClientSecretArn = aws_secretsmanager_secret.partner_client.arn
    PartnerUserPoolId              = aws_cognito_user_pool.partner.id
  }
}
