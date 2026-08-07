locals {
  secret_containers = toset([
    "cursor-signing",
    "database-admin-url",
    "model-adapter",
    "reference-client-auth",
    "temporal-cloud",
  ])
}

resource "google_sql_database_instance" "authority" {
  count = var.enabled ? 1 : 0

  project             = var.project_id
  name                = "${var.name_prefix}-postgres"
  region              = var.region
  database_version    = var.cloud_sql_database_version
  deletion_protection = false

  settings {
    tier              = var.cloud_sql_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = var.cloud_sql_disk_size_gb
    disk_autoresize   = true
    user_labels       = var.labels

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
      ssl_mode        = "TRUSTED_CLIENT_CERTIFICATE_REQUIRED"
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "05:00"
      location                       = "us"
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = var.cloud_sql_backup_retained_count
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = 7
      hour         = 6
      update_track = "stable"
    }
  }

}

resource "google_sql_database" "osfo" {
  count    = var.enabled ? 1 : 0
  project  = var.project_id
  name     = "osfo"
  instance = google_sql_database_instance.authority[0].name
}

resource "google_sql_user" "runtime" {
  for_each = var.enabled ? var.cloud_sql_service_accounts : {}
  project  = var.project_id
  instance = google_sql_database_instance.authority[0].name
  name     = trimsuffix(each.value, ".gserviceaccount.com")
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

resource "google_storage_bucket" "artifacts" {
  count = var.enabled ? 1 : 0

  project                     = var.project_id
  name                        = var.artifact_bucket_name
  location                    = var.region
  storage_class               = "STANDARD"
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = merge(var.labels, { purpose = "artifacts" })

  versioning { enabled = true }
  soft_delete_policy { retention_duration_seconds = 604800 }
}

resource "google_artifact_registry_repository" "images" {
  count = var.enabled ? 1 : 0

  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_registry_repository_id
  description   = "Osfo development images"
  format        = "DOCKER"
  mode          = "STANDARD_REPOSITORY"
  labels        = var.labels

  docker_config { immutable_tags = true }
}

resource "google_secret_manager_secret" "container" {
  for_each = var.enabled ? local.secret_containers : toset([])

  project   = var.project_id
  secret_id = "${var.name_prefix}-${each.key}"
  labels    = var.labels
  replication {
    auto {}
  }
}

output "cloud_sql_connection_name" { value = try(google_sql_database_instance.authority[0].connection_name, null) }
output "cloud_sql_private_ip" { value = try(google_sql_database_instance.authority[0].private_ip_address, null) }
output "artifact_registry_repository" { value = try(google_artifact_registry_repository.images[0].name, null) }
output "artifact_bucket_name" { value = try(google_storage_bucket.artifacts[0].name, null) }
output "evidence_archive_bucket_name" { value = var.evidence_archive_bucket_name }
output "secret_names" { value = { for key, secret in google_secret_manager_secret.container : key => secret.name } }
output "runtime_service_accounts" { value = var.enabled ? var.runtime_service_accounts : {} }
