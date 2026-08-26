mock_provider "google-beta" {}

mock_provider "google-beta" {
  alias = "project_factory"
}

run "isolated_firebase_plan" {
  command = plan

  variables {
    project_id           = "example-eoc-firebase-push"
    project_name         = "Example EOC Firebase"
    organization_id      = "123456789012"
    billing_account      = "ABCDEF-123456-ABCDEF"
    android_package_name = "org.example.eoc"
    android_display_name = "Example EOC Android"
  }

  assert {
    condition     = google_project.firebase.project_id == "example-eoc-firebase-push"
    error_message = "The Firebase project must use only its dedicated project identity."
  }

  assert {
    condition     = google_project.firebase.auto_create_network == false
    error_message = "The isolated Firebase project must not create a default network."
  }

  assert {
    condition     = google_firebase_project.push.project == google_project.firebase.project_id
    error_message = "Firebase must be enabled only in the dedicated project."
  }

  assert {
    condition     = google_firebase_android_app.push.package_name == "org.example.eoc"
    error_message = "The plan must register the exact configured Android application ID."
  }

  assert {
    condition     = length(google_project_service.required) == 7
    error_message = "The fixed Firebase API allowlist must not be widened."
  }

  assert {
    condition = (
      output.isolation_contract.state_prefix == "terraform/gcp/firebase-isolated" &&
      output.isolation_contract.application_writes_google_groups == false &&
      length(output.isolation_contract.cloud_identity_scopes) == 0 &&
      length(output.isolation_contract.project_iam_bindings) == 0 &&
      length(output.isolation_contract.service_accounts) == 0
    )
    error_message = "The planned root must retain its state, Groups, IAM, and service-account isolation contract."
  }
}
