variable "enabled" { type = bool }
variable "project_id" { type = string }
variable "region" { type = string }
variable "name_prefix" { type = string }
variable "runtime_service_accounts" { type = map(string) }
variable "network_id" {
  type     = string
  nullable = true
}
variable "cloud_sql_tier" { type = string }
variable "cloud_sql_disk_size_gb" { type = number }
variable "cloud_sql_database_version" { type = string }
variable "cloud_sql_backup_retained_count" { type = number }
variable "artifact_bucket_name" { type = string }
variable "artifact_registry_repository_id" { type = string }
variable "evidence_archive_bucket_name" { type = string }
variable "secret_accessors" { type = map(set(string)) }
variable "labels" { type = map(string) }
