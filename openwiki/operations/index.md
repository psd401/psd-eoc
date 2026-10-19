# Files

- [Tenant configuration, readiness register, and runbooks](configuration-and-readiness.md) - Where district-specific configuration lives (CDK context manifest, git-ignored cdk.local.json, runtime environment variables, mobile identifiers), how provider activation is gated, where current deployment and provider readiness is recorded, and how the runbook set is organized.
- [AWS CDK infrastructure, deployment, and monitoring](infrastructure.md) - The single PsdEoc CDK stack (App Runner web, Aurora, SQS queues, ECS channel workers, Lambdas, media and records storage), the local-only direct deploy rule, bootstrap-before-promotion ordering, CloudWatch monitoring, and the Google Cloud identity project.
