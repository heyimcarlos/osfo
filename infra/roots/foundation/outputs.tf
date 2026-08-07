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

output "qualification_evidence_bucket_name" {
  description = "Foundation storage for immutable, retained qualification evidence."
  value       = google_storage_bucket.qualification_evidence.name
}

output "terraform_service_accounts" {
  description = "Keyless root service-account identities."
  value       = { for environment, account in google_service_account.terraform : environment => account.email }
}

output "development_runtime_service_accounts" {
  description = "Active retained development runtime identities consumed by the disposable platform root."
  value = {
    for identity, account in google_service_account.development_runtime :
    identity => account.email
    if contains(local.development_runtime_identities, identity)
  }
}

output "development_qualification_service_accounts" {
  description = "Retained qualification-only identities consumed by disposable probe jobs."
  value       = { for identity, account in google_service_account.development_qualification : identity => account.email }
}

output "github_workload_identity_provider" {
  description = "Full Workload Identity Provider name consumed by GitHub authentication."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "region" {
  description = "Selected regional placement published for downstream roots."
  value       = var.region
}

output "development_environment_baseline" {
  description = "Retained development network identifiers consumed by disposable platform and runtime roots."
  value = {
    network_id                    = module.development_environment_baseline.network_id
    subnetwork_id                 = module.development_environment_baseline.subnetwork_id
    static_egress_ip              = module.development_environment_baseline.static_egress_ip
    temporal_endpoint_ip          = module.development_environment_baseline.temporal_endpoint_ip
    private_dns_managed_zone_id   = module.development_environment_baseline.private_dns_managed_zone_id
    private_dns_managed_zone_name = module.development_environment_baseline.private_dns_managed_zone_name
  }
}
