output "project_ids" {
  description = "Explicit non-secret project identifiers published for downstream roots."
  value       = { for environment, project in google_project.environment : environment => project.project_id }
}

output "state_bucket_names" {
  description = "Explicit non-secret state bucket identifiers used by backend configuration."
  value       = { for environment, bucket in google_storage_bucket.state : environment => bucket.name }
}

output "saved_plan_bucket_name" {
  description = "Foundation storage for encrypted saved plans with a one-day lifecycle."
  value       = google_storage_bucket.saved_plans.name
}

output "terraform_service_accounts" {
  description = "Keyless root service-account identities."
  value       = { for environment, account in google_service_account.terraform : environment => account.email }
}

output "github_workload_identity_provider" {
  description = "Full Workload Identity Provider name consumed by GitHub authentication."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "region" {
  description = "Selected regional placement published for downstream roots."
  value       = var.region
}
