variable "project_id" {
  description = "Globally unique Google Cloud project ID dedicated only to Firebase Cloud Messaging."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Provide a valid, dedicated Google Cloud project ID."
  }
}

variable "project_name" {
  description = "Human-readable name for the isolated Firebase project."
  type        = string

  validation {
    condition     = length(trimspace(var.project_name)) >= 4 && length(var.project_name) <= 30
    error_message = "Project name must contain 4 through 30 characters."
  }
}

variable "organization_id" {
  description = "Google Cloud organization that owns the isolated Firebase project."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[0-9]+$", var.organization_id))
    error_message = "Organization ID must contain decimal digits only."
  }
}

variable "billing_account" {
  description = "Billing account attached to the isolated Firebase project."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account))
    error_message = "Billing account must use the canonical 6-6-6 uppercase form."
  }
}

variable "android_package_name" {
  description = "Exact Android application ID registered with Firebase."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9]+([._-][A-Za-z0-9]+)+$", var.android_package_name))
    error_message = "Android package name is invalid."
  }
}

variable "android_display_name" {
  description = "Display name for the Firebase Android app."
  type        = string

  validation {
    condition     = length(trimspace(var.android_display_name)) >= 4 && length(var.android_display_name) <= 100
    error_message = "Android display name must contain 4 through 100 characters."
  }
}

variable "required_services" {
  description = "Fixed API allowlist for project creation and Firebase Cloud Messaging only."
  type        = set(string)
  default = [
    "cloudbilling.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "fcm.googleapis.com",
    "firebase.googleapis.com",
    "firebaseinstallations.googleapis.com",
    "fcmregistrations.googleapis.com",
    "iam.googleapis.com",
    "serviceusage.googleapis.com",
  ]

  validation {
    condition = var.required_services == toset([
      "cloudbilling.googleapis.com",
      "cloudresourcemanager.googleapis.com",
      "fcm.googleapis.com",
      "firebase.googleapis.com",
      "firebaseinstallations.googleapis.com",
      "fcmregistrations.googleapis.com",
      "iam.googleapis.com",
      "serviceusage.googleapis.com",
    ])
    error_message = "The isolated Firebase API allowlist cannot be widened with a variable override."
  }
}
