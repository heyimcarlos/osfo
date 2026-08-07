provider "google" {
  project               = var.project_id
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}

data "google_compute_network" "environment_baseline" {
  count = var.enable_managed_platform ? 1 : 0

  project = var.project_id
  name    = "${var.name_prefix}-vpc"
}

data "google_compute_subnetwork" "environment_baseline" {
  count = var.enable_managed_platform ? 1 : 0

  project = var.project_id
  region  = var.region
  name    = "${var.name_prefix}-us-east4"
}

data "google_compute_address" "environment_egress" {
  count = var.enable_managed_platform ? 1 : 0

  project = var.project_id
  region  = var.region
  name    = "${var.name_prefix}-egress"
}

module "data_authority" {
  source = "../../../modules/data-authority"

  enabled                  = var.enable_managed_platform
  project_id               = var.project_id
  region                   = var.region
  name_prefix              = var.name_prefix
  runtime_service_accounts = var.runtime_service_accounts
  cloud_sql_service_accounts = merge(var.runtime_service_accounts, {
    qualification_network = var.qualification_service_accounts["network"]
  })
  network_id                      = try(data.google_compute_network.environment_baseline[0].id, null)
  cloud_sql_tier                  = var.cloud_sql_tier
  cloud_sql_disk_size_gb          = var.cloud_sql_disk_size_gb
  cloud_sql_database_version      = var.cloud_sql_database_version
  cloud_sql_backup_retained_count = var.cloud_sql_backup_retained_count
  artifact_bucket_name            = var.artifact_bucket_name
  artifact_registry_repository_id = var.artifact_registry_repository_id
  evidence_archive_bucket_name    = var.evidence_archive_bucket_name
  labels                          = local.labels
}

module "command_buffer" {
  source = "../../../modules/command-buffer"

  enabled                    = var.enable_managed_platform
  project_id                 = var.project_id
  region                     = var.region
  name_prefix                = var.name_prefix
  message_retention_duration = var.pubsub_message_retention_duration
  labels                     = local.labels
}

resource "google_pubsub_topic_iam_member" "runtime_deployer_policy_manager" {
  count   = var.enable_managed_platform ? 1 : 0
  project = var.project_id
  topic   = module.command_buffer.topic_id
  role    = var.runtime_pubsub_policy_manager_role
  member  = "serviceAccount:${var.runtime_terraform_service_account_email}"
}

resource "google_pubsub_subscription_iam_member" "runtime_deployer_policy_manager" {
  count        = var.enable_managed_platform ? 1 : 0
  project      = var.project_id
  subscription = module.command_buffer.subscription_id
  role         = var.runtime_pubsub_policy_manager_role
  member       = "serviceAccount:${var.runtime_terraform_service_account_email}"
}

module "qualification_probe" {
  source = "../../../modules/qualification-probe"

  enabled                        = var.enable_managed_platform
  project_id                     = var.project_id
  region                         = var.region
  name_prefix                    = var.name_prefix
  network_name                   = try(data.google_compute_network.environment_baseline[0].name, null)
  subnetwork_name                = try(data.google_compute_subnetwork.environment_baseline[0].name, null)
  private_dns_zone_name          = "${var.name_prefix}-private"
  cloud_sql_connection_name      = module.data_authority.cloud_sql_connection_name
  cloud_sql_private_ip           = module.data_authority.cloud_sql_private_ip
  static_egress_ip               = try(data.google_compute_address.environment_egress[0].address, null)
  qualification_service_accounts = var.qualification_service_accounts
  secret_names                   = module.data_authority.secret_names
  probe_image                    = jsondecode(file("${path.root}/image-digests.json")).qualification_probe
  labels                         = local.labels
}

resource "terraform_data" "disposable_proof" {
  input = {
    environment = "development"
    token       = var.proof_token
  }
}

locals {
  labels = {
    environment = "development"
    managed_by  = "terraform"
    system      = "osfo"
    cost_owner  = var.cost_owner
  }
}

output "platform" {
  description = "Non-secret platform identifiers consumed by the development runtime root."
  value = {
    network_id                     = try(data.google_compute_network.environment_baseline[0].id, null)
    subnetwork_id                  = try(data.google_compute_subnetwork.environment_baseline[0].id, null)
    static_egress_ip               = try(data.google_compute_address.environment_egress[0].address, null)
    cloud_sql_connection_name      = module.data_authority.cloud_sql_connection_name
    cloud_sql_private_ip           = module.data_authority.cloud_sql_private_ip
    pubsub_topic_id                = module.command_buffer.topic_id
    pubsub_subscription_id         = module.command_buffer.subscription_id
    artifact_registry_repository   = module.data_authority.artifact_registry_repository
    artifact_bucket_name           = module.data_authority.artifact_bucket_name
    evidence_archive_bucket_name   = module.data_authority.evidence_archive_bucket_name
    secret_names                   = module.data_authority.secret_names
    runtime_service_accounts       = module.data_authority.runtime_service_accounts
    qualification_service_accounts = var.qualification_service_accounts
    qualification_probe_jobs       = module.qualification_probe.job_names
    qualification_secret_name      = module.qualification_probe.authorized_secret_name
    qualification_database_dns     = module.qualification_probe.database_dns_name
  }
}

output "operating_contract" {
  description = "Reviewed runtime bounds. These are inputs, not production-qualified defaults."
  value       = var.operating_contract
}

output "quota_requirements" {
  description = "Minimum regional and project quota values checked before apply."
  value       = var.quota_requirements
}

output "disposable_proof_id" {
  description = "Identifier for the disposable lifecycle proof."
  value       = terraform_data.disposable_proof.id
}
