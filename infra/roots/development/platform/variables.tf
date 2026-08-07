variable "project_id" { type = string }
variable "terraform_service_account_email" { type = string }
variable "runtime_service_accounts" {
  type = map(string)

  validation {
    condition = toset(keys(var.runtime_service_accounts)) == toset([
      "agentrun",
      "migration",
      "reconciliation",
      "relay",
      "temporal",
      "transport",
    ])
    error_message = "runtime_service_accounts must contain exactly the six reviewed development identities."
  }
}
variable "qualification_service_accounts" {
  type = map(string)

  validation {
    condition = toset(keys(var.qualification_service_accounts)) == toset([
      "denied_secret",
      "network",
    ])
    error_message = "qualification_service_accounts must contain exactly the two reviewed probe identities."
  }
}
variable "region" {
  type    = string
  default = "us-east4"
  validation {
    condition     = var.region == "us-east4"
    error_message = "The development platform is fixed to us-east4."
  }
}
variable "enable_managed_platform" { type = bool }
variable "name_prefix" { type = string }
variable "cost_owner" { type = string }
variable "proof_token" { type = string }
variable "cloud_sql_tier" { type = string }
variable "cloud_sql_disk_size_gb" { type = number }
variable "cloud_sql_database_version" { type = string }
variable "cloud_sql_backup_retained_count" { type = number }
variable "artifact_bucket_name" { type = string }
variable "artifact_registry_repository_id" { type = string }
variable "evidence_archive_bucket_name" { type = string }
variable "pubsub_message_retention_duration" { type = string }
variable "operating_contract" {
  type = object({
    transport_request_concurrency         = number
    transport_db_pool_connections         = number
    relay_worker_count                    = number
    relay_publisher_count                 = number
    relay_db_pool_connections             = number
    agentrun_worker_count                 = number
    agentrun_streams_per_worker           = number
    agentrun_execution_slots_per_worker   = number
    agentrun_db_pool_connections          = number
    temporal_worker_count                 = number
    temporal_db_pool_connections          = number
    application_log_retention_days        = number
    security_log_retention_days           = number
    metric_retention_days                 = number
    qualification_evidence_retention_days = number
  })
}
variable "quota_requirements" { type = map(number) }
