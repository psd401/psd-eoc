output "firebase_project" {
  description = "Non-secret identity of the isolated Firebase project."
  value = {
    id     = google_project.firebase.project_id
    number = google_project.firebase.number
  }
}

output "android_app" {
  description = "Non-secret exact Android app registration."
  value = {
    app_id       = google_firebase_android_app.push.app_id
    package_name = google_firebase_android_app.push.package_name
  }
}

output "isolation_contract" {
  description = "Machine-readable proof that this root owns no roster or Groups authority."
  value = {
    state_prefix                     = "terraform/gcp/firebase-isolated"
    application_writes_google_groups = false
    cloud_identity_scopes            = []
    project_iam_bindings             = []
    service_accounts                 = []
  }
}
