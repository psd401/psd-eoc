# Isolated Firebase Cloud Messaging project

This Terraform root creates a dedicated Google Cloud project, enables Firebase,
and registers the exact Android application used through Expo. It is
intentionally separate from the parent Google Groups root: it has a different
project, a different state bucket and prefix, no service accounts, no project
IAM grants, no Cloud Identity or Admin SDK APIs, and no roster scope.

The checked-in backend bucket is deliberately unusable. Before the first plan,
copy `backend.hcl.example` and `firebase.tfvars.example` outside the repository,
replace every placeholder with protected operator values, and initialize with:

```sh
terraform init -reconfigure -backend-config=/protected/path/backend.hcl
terraform plan -var-file=/protected/path/firebase.tfvars
```

The credential-free isolation plan used by issue #278 and CI requires
Terraform 1.7.5 or newer and uses mocked providers, so it never creates or
reads a cloud resource:

```sh
terraform init -backend=false
terraform test
```

Never place `google-services.json`, provider credentials, Terraform state, a
plan file, or real device tokens in this repository. Creating credentials and
linking FCM to EAS remains a human provider-console action. Applying this root
does not authorize a notification or prove delivery.
