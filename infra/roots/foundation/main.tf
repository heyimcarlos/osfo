locals {
  environments = toset(["foundation", "development", "production"])
  development_artifact_bucket_name = coalesce(
    var.development_artifact_bucket_name,
    "osfo-development-artifacts-${split("-", var.project_ids.development)[2]}",
  )

  root_identities = {
    foundation = {
      account_id         = "osfo-foundation-tf"
      environment        = "foundation"
      github_environment = "foundation"
      plan_prefix        = "roots/foundation/"
      state_prefix       = "roots/foundation/"
    }
    development-platform = {
      account_id         = "osfo-dev-platform-tf"
      environment        = "development"
      github_environment = "development-platform"
      plan_prefix        = "roots/development/platform/"
      state_prefix       = "roots/development/platform/"
    }
    development-runtime = {
      account_id         = "osfo-dev-runtime-tf"
      environment        = "development"
      github_environment = "development-runtime"
      plan_prefix        = "roots/development/runtime/"
      state_prefix       = "roots/development/runtime/"
    }
    production-platform = {
      account_id         = "osfo-prod-platform-tf"
      environment        = "production"
      github_environment = "production-platform"
      plan_prefix        = "roots/production/platform/"
      state_prefix       = "roots/production/platform/"
    }
    production-runtime = {
      account_id         = "osfo-prod-runtime-tf"
      environment        = "production"
      github_environment = "production-runtime"
      plan_prefix        = "roots/production/runtime/"
      state_prefix       = "roots/production/runtime/"
    }
  }

  base_project_services = {
    for pair in setproduct(local.environments, toset([
      "cloudresourcemanager.googleapis.com",
      "iam.googleapis.com",
      "iamcredentials.googleapis.com",
      "logging.googleapis.com",
      "orgpolicy.googleapis.com",
      "serviceusage.googleapis.com",
      "sts.googleapis.com",
      "storage.googleapis.com",
      ])) : "${pair[0]}/${pair[1]}" => {
      environment = pair[0]
      service     = pair[1]
    }
  }

  development_platform_services = {
    for service in toset([
      "artifactregistry.googleapis.com",
      "cloudquotas.googleapis.com",
      "compute.googleapis.com",
      "dns.googleapis.com",
      "pubsub.googleapis.com",
      "run.googleapis.com",
      "secretmanager.googleapis.com",
      "servicedirectory.googleapis.com",
      "servicenetworking.googleapis.com",
      "sqladmin.googleapis.com",
      ]) : "development/${service}" => {
      environment = "development"
      service     = service
    }
  }

  project_services = merge(local.base_project_services, local.development_platform_services)

  non_foundation_project_roles = toset([
    "roles/iam.serviceAccountAdmin",
    "roles/logging.configWriter",
    "roles/resourcemanager.projectIamAdmin",
    "roles/serviceusage.serviceUsageAdmin",
  ])

  development_foundation_project_roles = setunion(local.non_foundation_project_roles, toset([
    "roles/compute.networkAdmin",
    "roles/compute.securityAdmin",
    "roles/dns.admin",
    "roles/iam.roleAdmin",
    "roles/servicenetworking.networksAdmin",
  ]))

  foundation_project_roles = {
    foundation = toset([
      "roles/iam.roleAdmin",
      "roles/iam.serviceAccountAdmin",
      "roles/iam.workloadIdentityPoolAdmin",
      "roles/logging.configWriter",
      "roles/resourcemanager.projectIamAdmin",
      "roles/serviceusage.serviceUsageAdmin",
    ])
    development = local.development_foundation_project_roles
    production  = local.non_foundation_project_roles
  }

  foundation_role_bindings = {
    for binding in flatten([
      for environment, roles in local.foundation_project_roles : [
        for role in roles : {
          environment = environment
          role        = role
        }
      ]
    ]) : "${binding.environment}/${binding.role}" => binding
  }

  platform_project_roles = toset([
    "roles/artifactregistry.admin",
    "roles/cloudsql.admin",
    "roles/cloudquotas.viewer",
    "roles/compute.networkViewer",
    "roles/dns.admin",
    "roles/iam.serviceAccountViewer",
    "roles/logging.viewer",
    "roles/pubsub.admin",
    "roles/run.admin",
    "roles/serviceusage.serviceUsageViewer",
  ])

  platform_role_bindings = {
    for role in local.platform_project_roles : role => { environment = "development", role = role }
  }

  development_runtime_identities = toset([
    "agentrun",
    "migration",
    "reconciliation",
    "relay",
    "temporal",
    "transport",
  ])

  development_runtime_cloud_sql_bindings = {
    for binding in setproduct(local.development_runtime_identities, toset([
      "roles/cloudsql.client",
      "roles/cloudsql.instanceUser",
      ])) : "${binding[0]}/${binding[1]}" => {
      identity = binding[0]
      role     = binding[1]
    }
  }

  development_qualification_identities = {
    denied_secret = "qual-denied"
    network       = "qual-network"
  }

  development_secret_access_bindings = {
    runtime_agentrun = {
      identity = "agentrun"
      secret   = "model-adapter"
    }
    runtime_temporal = {
      identity = "temporal"
      secret   = "temporal-cloud"
    }
  }

  security_constraints = var.organization_id == null ? {} : {
    for pair in setproduct(local.environments, toset([
      "iam.automaticIamGrantsForDefaultServiceAccounts",
      "iam.disableServiceAccountKeyCreation",
      "iam.disableServiceAccountKeyUpload",
      ])) : "${pair[0]}/${pair[1]}" => {
      environment = pair[0]
      constraint  = pair[1]
    }
  }
}

resource "google_project_iam_custom_role" "platform_secret_manager" {
  project     = google_project.environment["development"].project_id
  role_id     = "osfoPlatformSecretManager"
  title       = "Osfo platform secret manager"
  description = "Manages secret containers and new versions without reading payloads or changing IAM."
  permissions = [
    "resourcemanager.projects.get",
    "secretmanager.locations.get",
    "secretmanager.locations.list",
    "secretmanager.secrets.create",
    "secretmanager.secrets.delete",
    "secretmanager.secrets.get",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.list",
    "secretmanager.secrets.update",
    "secretmanager.versions.add",
  ]

  lifecycle { prevent_destroy = true }

  depends_on = [google_project_service.required, google_project_iam_member.foundation]
}

resource "google_project_iam_custom_role" "platform_service_consumer" {
  project     = google_project.environment["development"].project_id
  role_id     = "osfoPlatformServiceConsumer"
  title       = "Osfo platform service consumer"
  description = "Uses enabled project services without changing service configuration."
  permissions = ["serviceusage.services.use"]

  lifecycle { prevent_destroy = true }

  depends_on = [google_project_service.required, google_project_iam_member.foundation]
}

resource "google_project_iam_custom_role" "platform_storage_manager" {
  project     = google_project.environment["development"].project_id
  role_id     = "osfoPlatformStorageManager"
  title       = "Osfo platform storage manager"
  description = "Manages disposable bucket metadata and creates immutable objects without delete or overwrite authority."
  permissions = [
    "storage.buckets.create",
    "storage.buckets.delete",
    "storage.buckets.get",
    "storage.buckets.list",
    "storage.buckets.update",
    "storage.objects.create",
    "storage.objects.get",
    "storage.objects.list",
  ]

  lifecycle { prevent_destroy = true }

  depends_on = [google_project_service.required, google_project_iam_member.foundation]
}

resource "google_project_iam_custom_role" "development_artifact_cleaner" {
  project     = google_project.environment["development"].project_id
  role_id     = "osfoDevelopmentArtifactCleaner"
  title       = "Osfo development artifact cleaner"
  description = "Lets the foundation recovery path inspect and delete disposable artifact objects before bucket teardown."
  permissions = [
    "storage.buckets.get",
    "storage.objects.delete",
    "storage.objects.get",
    "storage.objects.list",
  ]

  lifecycle { prevent_destroy = true }

  depends_on = [google_project_service.required, google_project_iam_member.foundation]
}

resource "google_project" "environment" {
  for_each = local.environments

  project_id          = var.project_ids[each.key]
  name                = "osfo-${each.key}"
  org_id              = var.organization_id
  billing_account     = var.billing_account
  auto_create_network = false
  deletion_policy     = "PREVENT"

  labels = {
    environment = each.key
    managed_by  = "terraform"
    system      = "osfo"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_project_service" "required" {
  for_each = local.project_services

  project                    = google_project.environment[each.value.environment].project_id
  service                    = each.value.service
  disable_dependent_services = false
  disable_on_destroy         = false
}

module "development_environment_baseline" {
  source = "../../modules/environment-baseline"

  enabled     = true
  project_id  = google_project.environment["development"].project_id
  region      = var.region
  name_prefix = var.development_environment_baseline.name_prefix
  labels = {
    environment = "development"
    managed_by  = "terraform"
    system      = "osfo"
    cost_owner  = var.development_environment_baseline.cost_owner
  }
  network_cidr                    = var.development_environment_baseline.network_cidr
  private_service_cidr_prefix     = var.development_environment_baseline.private_service_cidr_prefix
  temporal_service_attachment_uri = var.development_environment_baseline.temporal_service_attachment_uri
  temporal_dns_name               = var.development_environment_baseline.temporal_dns_name

  depends_on = [google_project_service.required, google_project_iam_member.foundation]
}

resource "google_org_policy_policy" "security" {
  for_each = local.security_constraints

  parent = "projects/${google_project.environment[each.value.environment].number}"
  name   = "projects/${google_project.environment[each.value.environment].number}/policies/${each.value.constraint}"

  spec {
    rules {
      enforce = "TRUE"
    }
  }

  depends_on = [
    google_organization_iam_member.foundation_org_policy_admin,
    google_project_service.required,
  ]
}

resource "google_storage_bucket" "state" {
  for_each = local.environments

  name                        = var.state_bucket_names[each.key]
  project                     = google_project.environment["foundation"].project_id
  location                    = "US"
  storage_class               = "STANDARD"
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    environment = each.key
    managed_by  = "terraform"
    purpose     = "terraform-state"
    system      = "osfo"
  }

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 2592000
  }

  retention_policy {
    is_locked        = true
    retention_period = 2592000
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_noncurrent_time = 90
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket" "saved_plans" {
  name                        = var.saved_plan_bucket_name
  project                     = google_project.environment["foundation"].project_id
  location                    = "US"
  storage_class               = "STANDARD"
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    environment = "foundation"
    managed_by  = "terraform"
    purpose     = "terraform-saved-plans"
    system      = "osfo"
  }

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 0
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 1
    }
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_noncurrent_time = 1
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket" "qualification_evidence" {
  project                     = google_project.environment["foundation"].project_id
  name                        = var.qualification_evidence_bucket_name
  location                    = "US"
  storage_class               = "STANDARD"
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    environment = "foundation"
    managed_by  = "terraform"
    purpose     = "qualification-evidence"
    system      = "osfo"
  }

  versioning { enabled = true }
  retention_policy { retention_period = 34214400 }
  soft_delete_policy { retention_duration_seconds = 2592000 }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required]
}

resource "google_service_account" "terraform" {
  for_each = local.root_identities

  project      = google_project.environment[each.value.environment].project_id
  account_id   = each.value.account_id
  display_name = "Osfo ${title(each.key)} Terraform root"
  description  = "Keyless identity for the isolated ${each.key} Terraform root."

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = google_project.environment["foundation"].project_id
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
  description               = "Keyless GitHub Actions identities for ${var.github_repository}."
  disabled                  = false

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = google_project.environment["foundation"].project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"
  description                        = "Trusts only the immutable Osfo repository and owner identities."

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.ref"              = "assertion.ref"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_id"    = "assertion.repository_id"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.environment"      = "assertion.environment"
  }

  attribute_condition = "assertion.repository_owner_id == '${var.github_repository_owner_id}' && assertion.repository_id == '${var.github_repository_id}' && assertion.ref == 'refs/heads/main'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account_iam_member" "github_workload_identity" {
  for_each = local.root_identities

  service_account_id = google_service_account.terraform[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.environment/${each.value.github_environment}"
}

resource "google_storage_bucket_iam_member" "state" {
  for_each = local.root_identities

  bucket = google_storage_bucket.state[each.value.environment].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.terraform[each.key].email}"

  condition {
    title       = "${replace(each.key, "-", "_")}_state_prefix"
    description = "Restricts this root identity to its own Terraform state prefix."
    expression  = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.state[each.value.environment].name}/objects/${each.value.state_prefix}')"
  }
}

resource "google_project_iam_custom_role" "state_object_lister" {
  project     = google_project.environment["foundation"].project_id
  role_id     = "osfoStateObjectLister"
  title       = "Osfo state object lister"
  description = "Lists backend object names without granting object payload access."
  permissions = ["storage.objects.list"]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_project_iam_custom_role" "saved_plan_object_access" {
  project     = google_project.environment["foundation"].project_id
  role_id     = "osfoSavedPlanObjectAccess"
  title       = "Osfo saved plan object access"
  description = "Creates and reads immutable saved plans without list, update, or delete access."
  permissions = [
    "storage.objects.create",
    "storage.objects.get",
  ]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_storage_bucket_iam_member" "state_list" {
  for_each = local.root_identities

  bucket = google_storage_bucket.state[each.value.environment].name
  role   = google_project_iam_custom_role.state_object_lister.name
  member = "serviceAccount:${google_service_account.terraform[each.key].email}"
}

resource "google_storage_bucket_iam_member" "saved_plans" {
  for_each = local.root_identities

  bucket = google_storage_bucket.saved_plans.name
  role   = google_project_iam_custom_role.saved_plan_object_access.name
  member = "serviceAccount:${google_service_account.terraform[each.key].email}"

  condition {
    title       = "${replace(each.key, "-", "_")}_saved_plan_prefix"
    description = "Restricts this root identity to its own saved-plan prefix."
    expression  = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.saved_plans.name}/objects/${each.value.plan_prefix}')"
  }
}

resource "google_project_iam_custom_role" "state_bucket_admin" {
  project     = google_project.environment["foundation"].project_id
  role_id     = "osfoStateBucketAdmin"
  title       = "Osfo state bucket administrator"
  description = "Manages state bucket metadata and IAM without granting state object access."
  permissions = [
    "storage.buckets.create",
    "storage.buckets.get",
    "storage.buckets.getIamPolicy",
    "storage.buckets.list",
    "storage.buckets.setIamPolicy",
    "storage.buckets.update",
  ]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_project_iam_member" "foundation_state_bucket_admin" {
  project = google_project.environment["foundation"].project_id
  role    = google_project_iam_custom_role.state_bucket_admin.name
  member  = "serviceAccount:${google_service_account.terraform["foundation"].email}"
}

resource "google_project_iam_member" "foundation" {
  for_each = local.foundation_role_bindings

  project = google_project.environment[each.value.environment].project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.terraform["foundation"].email}"
}

resource "google_project_iam_member" "platform" {
  for_each = local.platform_role_bindings

  project = google_project.environment[each.value.environment].project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.terraform["${each.value.environment}-platform"].email}"
}

resource "google_compute_subnetwork_iam_member" "development_platform_network_user" {
  project    = google_project.environment["development"].project_id
  region     = var.region
  subnetwork = module.development_environment_baseline.subnetwork_id
  role       = "roles/compute.networkUser"
  member     = "serviceAccount:${google_service_account.terraform["development-platform"].email}"
}

resource "google_project_iam_member" "platform_secret_manager" {
  project = google_project.environment["development"].project_id
  role    = google_project_iam_custom_role.platform_secret_manager.name
  member  = "serviceAccount:${google_service_account.terraform["development-platform"].email}"
}

resource "google_project_iam_member" "platform_service_consumer" {
  project = google_project.environment["development"].project_id
  role    = google_project_iam_custom_role.platform_service_consumer.name
  member  = "serviceAccount:${google_service_account.terraform["development-platform"].email}"
}

resource "google_project_iam_member" "platform_storage_manager" {
  project = google_project.environment["development"].project_id
  role    = google_project_iam_custom_role.platform_storage_manager.name
  member  = "serviceAccount:${google_service_account.terraform["development-platform"].email}"
}

resource "google_project_iam_member" "development_artifact_cleaner" {
  project = google_project.environment["development"].project_id
  role    = google_project_iam_custom_role.development_artifact_cleaner.name
  member  = "serviceAccount:${google_service_account.terraform["foundation"].email}"

  condition {
    title       = "exact_development_artifact_bucket"
    description = "Restricts foundation cleanup to the reviewed disposable artifact bucket."
    expression  = "resource.name == 'projects/_/buckets/${local.development_artifact_bucket_name}' || resource.name.startsWith('projects/_/buckets/${local.development_artifact_bucket_name}/objects/')"
  }
}

resource "google_project_iam_member" "development_runtime_cloud_sql" {
  for_each = local.development_runtime_cloud_sql_bindings

  project = google_project.environment["development"].project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.development_runtime[each.value.identity].email}"
}

resource "google_project_iam_member" "development_qualification_cloud_sql_client" {
  project = google_project.environment["development"].project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.development_qualification["network"].email}"
}

resource "google_project_iam_member" "development_qualification_cloud_sql_instance_user" {
  project = google_project.environment["development"].project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${google_service_account.development_qualification["network"].email}"
}

resource "google_project_iam_member" "development_secret_access" {
  for_each = local.development_secret_access_bindings

  project = google_project.environment["development"].project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.development_runtime[each.value.identity].email}"

  condition {
    title       = "${replace(each.key, "_", "-")}-secret"
    description = "Restricts the retained identity to one reviewed disposable secret."
    expression  = "resource.name.startsWith('projects/${google_project.environment["development"].number}/secrets/${var.development_environment_baseline.name_prefix}-${each.value.secret}/versions/')"
  }
}

resource "google_service_account" "development_runtime" {
  for_each = local.development_runtime_identities

  project      = google_project.environment["development"].project_id
  account_id   = "${var.development_environment_baseline.name_prefix}-${each.key}"
  display_name = "Osfo development ${each.key}"
  description  = "Retained identity for repeatable disposable development platform lifecycles."

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required]
}

resource "google_service_account" "development_qualification" {
  for_each = local.development_qualification_identities

  project      = google_project.environment["development"].project_id
  account_id   = "${var.development_environment_baseline.name_prefix}-${each.value}"
  display_name = "Osfo development ${replace(each.key, "_", " ")} probe"
  description  = "Retained qualification-only identity with no runtime authority."

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required]
}

resource "google_service_account_iam_member" "development_platform_probe_act_as" {
  for_each = google_service_account.development_qualification

  service_account_id = each.value.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.terraform["development-platform"].email}"
}

resource "google_storage_bucket_iam_member" "development_evidence" {
  bucket = google_storage_bucket.qualification_evidence.name
  role   = google_project_iam_custom_role.saved_plan_object_access.name
  member = "serviceAccount:${google_service_account.terraform["development-platform"].email}"

  condition {
    title       = "development_platform_evidence_prefix"
    description = "Restricts development qualification evidence to its immutable prefix."
    expression  = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.qualification_evidence.name}/objects/roots/development/platform/')"
  }
}

resource "google_organization_iam_member" "foundation_org_policy_admin" {
  count = var.organization_id == null ? 0 : 1

  org_id = var.organization_id
  role   = "roles/orgpolicy.policyAdmin"
  member = "serviceAccount:${google_service_account.terraform["foundation"].email}"
}

resource "google_project_iam_audit_config" "all_services" {
  for_each = local.environments

  project = google_project.environment[each.key].project_id
  service = "allServices"

  audit_log_config {
    log_type = "ADMIN_READ"
  }

  audit_log_config {
    log_type = "DATA_READ"
  }

  audit_log_config {
    log_type = "DATA_WRITE"
  }
}
