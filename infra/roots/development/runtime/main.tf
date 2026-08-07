provider "google" {
  project               = var.project_id
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}

locals {
  images                    = jsondecode(file("${path.root}/image-digests.json"))
  application_image         = try(local.images.application, null)
  cloud_sql_proxy_image     = local.images.cloud_sql_auth_proxy
  secret_versions_ready     = var.cursor_secret_version != null && var.model_adapter_secret_version != null
  runtime_ready             = var.platform_ready && local.application_image != null && local.secret_versions_ready
  serving_ready             = local.runtime_ready && var.serving_enabled
  public_edge_ready         = local.serving_ready && var.public_hostname != null
  runtime_identity_names    = toset(["agentrun", "relay", "transport"])
  runtime_service_accounts  = { for identity in local.runtime_identity_names : identity => "${var.name_prefix}-${identity}@${var.project_id}.iam.gserviceaccount.com" }
  database_roles            = { for identity, email in local.runtime_service_accounts : identity => trimsuffix(email, ".gserviceaccount.com") }
  database_users            = { for identity, role in local.database_roles : identity => urlencode(role) }
  database_urls             = { for identity, user in local.database_users : identity => "postgresql://${user}@127.0.0.1:5432/osfo?sslmode=disable" }
  cloud_sql_connection_name = "${var.project_id}:${var.region}:${var.name_prefix}-postgres"
  network_name              = "${var.name_prefix}-vpc"
  subnetwork_name           = "${var.name_prefix}-us-east4"
  topic_name                = "${var.name_prefix}-agentruns"
  subscription_name         = "${var.name_prefix}-agentruns"
  cursor_secret_name        = "${var.name_prefix}-cursor-signing"
  model_adapter_secret_name = "${var.name_prefix}-model-adapter"
  common_proxy_args         = ["--auto-iam-authn", "--private-ip", "--address=127.0.0.1", "--port=5432", local.cloud_sql_connection_name]
  labels = {
    environment          = "development"
    managed_by           = "terraform"
    system               = "osfo"
    production_candidate = "unqualified"
  }
}

data "google_compute_network" "runtime" {
  count   = var.platform_ready ? 1 : 0
  project = var.project_id
  name    = local.network_name
}

data "google_compute_subnetwork" "runtime" {
  count   = var.platform_ready ? 1 : 0
  project = var.project_id
  region  = var.region
  name    = local.subnetwork_name
}

resource "google_cloud_run_v2_service" "transport" {
  count               = local.serving_ready ? 1 : 0
  project             = var.project_id
  location            = var.region
  name                = "${var.name_prefix}-transport"
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  labels              = local.labels

  template {
    service_account                  = local.runtime_service_accounts.transport
    max_instance_request_concurrency = var.operating_contract.transport_request_concurrency
    timeout                          = "3600s"
    scaling {
      min_instance_count = 1
      max_instance_count = var.operating_contract.transport_max_instances
    }
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = data.google_compute_network.runtime[0].name
        subnetwork = data.google_compute_subnetwork.runtime[0].name
      }
    }
    containers {
      name       = "transport"
      image      = local.application_image
      command    = ["node"]
      args       = ["apps/ingress/dist/main.js"]
      depends_on = ["cloud-sql-auth-proxy"]
      ports { container_port = 8080 }
      env {
        name  = "OSFO_INGRESS_HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "OSFO_INGRESS_PORT"
        value = "8080"
      }
      env {
        name  = "OSFO_WEB_ROOT"
        value = "/srv/osfo/apps/web/dist"
      }
      env {
        name  = "OSFO_DATABASE_URL"
        value = local.database_urls.transport
      }
      env {
        name  = "OSFO_EXECUTION_PROFILE_REF"
        value = var.execution_profile_ref
      }
      env {
        name  = "OSFO_GLOBAL_NON_TERMINAL_LIMIT"
        value = "256"
      }
      env {
        name  = "OSFO_PRINCIPAL_NON_TERMINAL_LIMIT"
        value = "64"
      }
      env {
        name  = "OSFO_ADMISSION_DATABASE_POOL_MAX"
        value = tostring(var.operating_contract.transport_admission_db_pool)
      }
      env {
        name  = "OSFO_RESUME_DATABASE_POOL_MAX"
        value = tostring(var.operating_contract.transport_resume_db_pool)
      }
      env {
        name  = "OSFO_MAX_STREAM_CONNECTIONS"
        value = tostring(var.operating_contract.transport_max_stream_connections)
      }
      env {
        name = "OSFO_CURSOR_SECRET"
        value_source {
          secret_key_ref {
            secret  = local.cursor_secret_name
            version = var.cursor_secret_version
          }
        }
      }
      startup_probe {
        http_get { path = "/healthz" }
      }
      liveness_probe {
        http_get { path = "/healthz" }
      }
      resources {
        limits   = { cpu = "1", memory = "1Gi" }
        cpu_idle = false
      }
    }
    containers {
      name  = "cloud-sql-auth-proxy"
      image = local.cloud_sql_proxy_image
      args  = local.common_proxy_args
      startup_probe {
        tcp_socket { port = 5432 }
      }
      resources { limits = { cpu = "1", memory = "256Mi" } }
    }
  }

}

resource "google_cloud_run_v2_service_iam_member" "transport_public_invoker" {
  count    = local.public_edge_ready ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.transport[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_worker_pool" "relay" {
  count               = local.serving_ready ? 1 : 0
  project             = var.project_id
  location            = var.region
  name                = "${var.name_prefix}-relay"
  deletion_protection = false
  launch_stage        = "BETA"
  labels              = local.labels

  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = var.operating_contract.relay_worker_count
  }

  template {
    service_account = local.runtime_service_accounts.relay
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = data.google_compute_network.runtime[0].name
        subnetwork = data.google_compute_subnetwork.runtime[0].name
      }
    }
    containers {
      name       = "relay"
      image      = local.application_image
      command    = ["node"]
      args       = ["apps/outbox-relay/dist/main.js"]
      depends_on = ["cloud-sql-auth-proxy"]
      env {
        name  = "OSFO_DATABASE_URL"
        value = local.database_urls.relay
      }
      env {
        name  = "OSFO_RELAY_DATABASE_POOL_MAX"
        value = tostring(var.operating_contract.relay_db_pool_connections)
      }
      env {
        name  = "OSFO_RELAY_PUBLISHER_CONCURRENCY"
        value = tostring(var.operating_contract.relay_publisher_count)
      }
      env {
        name  = "OSFO_RELAY_PUBLICATION_WINDOW_SIZE"
        value = tostring(var.operating_contract.relay_publication_window)
      }
      env {
        name  = "OSFO_RELAY_SAFETY_DRAIN_INTERVAL_MS"
        value = tostring(var.operating_contract.relay_safety_drain_ms)
      }
      env {
        name  = "OSFO_PUBSUB_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "OSFO_PUBSUB_TOPIC_ID"
        value = local.topic_name
      }
      resources { limits = { cpu = "1", memory = "512Mi" } }
    }
    containers {
      name  = "cloud-sql-auth-proxy"
      image = local.cloud_sql_proxy_image
      args  = local.common_proxy_args
      startup_probe {
        tcp_socket { port = 5432 }
      }
      resources { limits = { cpu = "1", memory = "256Mi" } }
    }
  }
}

resource "google_cloud_run_v2_worker_pool" "agentrun" {
  count               = local.serving_ready ? 1 : 0
  project             = var.project_id
  location            = var.region
  name                = "${var.name_prefix}-agentrun"
  deletion_protection = false
  launch_stage        = "BETA"
  labels              = local.labels

  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = var.operating_contract.agentrun_worker_count
  }

  template {
    service_account = local.runtime_service_accounts.agentrun
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = data.google_compute_network.runtime[0].name
        subnetwork = data.google_compute_subnetwork.runtime[0].name
      }
    }
    containers {
      name       = "agentrun"
      image      = local.application_image
      command    = ["node"]
      args       = ["apps/agent-run-worker/dist/main.js"]
      depends_on = ["cloud-sql-auth-proxy"]
      env {
        name  = "OSFO_DATABASE_URL"
        value = local.database_urls.agentrun
      }
      env {
        name  = "OSFO_DATABASE_POOL_MAX"
        value = tostring(var.operating_contract.agentrun_db_pool_connections)
      }
      env {
        name  = "OSFO_AGENT_RUN_EXECUTION_SLOTS"
        value = tostring(var.operating_contract.agentrun_execution_slots_per_worker)
      }
      env {
        name  = "OSFO_AGENT_RUN_LEASE_DURATION_MS"
        value = tostring(var.operating_contract.agentrun_lease_duration_ms)
      }
      env {
        name  = "OSFO_AGENT_RUN_LEASE_RENEWAL_INTERVAL_MS"
        value = tostring(var.operating_contract.agentrun_lease_renewal_interval_ms)
      }
      env {
        name  = "OSFO_AGENT_RUN_CANCELLATION_POLL_INTERVAL_MS"
        value = tostring(var.operating_contract.agentrun_cancellation_poll_interval_ms)
      }
      env {
        name  = "OSFO_AGENT_RUN_CANCELLATION_GRACE_MS"
        value = tostring(var.operating_contract.agentrun_cancellation_grace_ms)
      }
      env {
        name  = "OSFO_AGENT_RUN_TERMINATION_DEADLINE_MS"
        value = tostring(var.operating_contract.agentrun_termination_deadline_ms)
      }
      env {
        name  = "OSFO_PUBSUB_STREAM_COUNT"
        value = tostring(var.operating_contract.agentrun_streams_per_worker)
      }
      env {
        name  = "OSFO_PUBSUB_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "OSFO_PUBSUB_SUBSCRIPTION_ID"
        value = local.subscription_name
      }
      env {
        name  = "OSFO_EXECUTION_PROFILE_REF"
        value = var.execution_profile_ref
      }
      env {
        name = "OPENROUTER_API_KEY"
        value_source {
          secret_key_ref {
            secret  = local.model_adapter_secret_name
            version = var.model_adapter_secret_version
          }
        }
      }
      resources { limits = { cpu = "2", memory = "1Gi" } }
    }
    containers {
      name  = "cloud-sql-auth-proxy"
      image = local.cloud_sql_proxy_image
      args  = local.common_proxy_args
      startup_probe {
        tcp_socket { port = 5432 }
      }
      resources { limits = { cpu = "1", memory = "256Mi" } }
    }
  }
}

resource "google_pubsub_topic_iam_member" "relay_publisher" {
  count   = local.serving_ready ? 1 : 0
  project = var.project_id
  topic   = local.topic_name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${local.runtime_service_accounts.relay}"
}

resource "google_pubsub_subscription_iam_member" "agentrun_subscriber" {
  count        = local.serving_ready ? 1 : 0
  project      = var.project_id
  subscription = local.subscription_name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${local.runtime_service_accounts.agentrun}"
}

resource "google_compute_global_address" "edge" {
  count   = local.serving_ready ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-edge"
}

resource "google_compute_region_network_endpoint_group" "transport" {
  count                 = local.public_edge_ready ? 1 : 0
  project               = var.project_id
  region                = var.region
  name                  = "${var.name_prefix}-transport"
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.transport[0].name
  }
}

resource "google_compute_security_policy" "edge" {
  count   = local.public_edge_ready ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-edge"
  type    = "CLOUD_ARMOR"

  rule {
    action   = "deny(403)"
    priority = 1000
    match {
      expr { expression = "evaluatePreconfiguredWaf('xss-v33-stable')" }
    }
    description = "Reject preconfigured cross-site scripting signatures."
  }
  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config { src_ip_ranges = ["*"] }
    }
    description = "Default allow after application-layer bearer authentication."
  }
}

resource "google_compute_backend_service" "transport" {
  count                 = local.public_edge_ready ? 1 : 0
  project               = var.project_id
  name                  = "${var.name_prefix}-transport"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  timeout_sec           = 3600
  security_policy       = google_compute_security_policy.edge[0].id
  backend {
    group = google_compute_region_network_endpoint_group.transport[0].id
  }
}

resource "google_compute_managed_ssl_certificate" "edge" {
  count   = local.public_edge_ready ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-edge"
  managed {
    domains = [coalesce(var.public_hostname, "missing.invalid")]
  }
}

resource "google_compute_url_map" "edge" {
  count           = local.public_edge_ready ? 1 : 0
  project         = var.project_id
  name            = "${var.name_prefix}-edge"
  default_service = google_compute_backend_service.transport[0].id
}

resource "google_compute_target_https_proxy" "edge" {
  count            = local.public_edge_ready ? 1 : 0
  project          = var.project_id
  name             = "${var.name_prefix}-edge"
  url_map          = google_compute_url_map.edge[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.edge[0].id]
}

resource "google_compute_global_forwarding_rule" "edge" {
  count                 = local.public_edge_ready ? 1 : 0
  project               = var.project_id
  name                  = "${var.name_prefix}-edge"
  ip_address            = google_compute_global_address.edge[0].address
  port_range            = "443"
  target                = google_compute_target_https_proxy.edge[0].id
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

resource "google_monitoring_dashboard" "runtime" {
  count   = local.serving_ready ? 1 : 0
  project = var.project_id
  dashboard_json = jsonencode({
    displayName = "Osfo development runtime, unqualified candidate"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          width  = 12
          height = 2
          widget = { text = { content = "# Development demo only\nFixed-one relay and six-worker candidate. Production qualification: MISSING. Final us-east4 A/B/C/D admission matrix: FAIL.", format = "MARKDOWN" } }
        },
        {
          width  = 6
          height = 4
          widget = {
            title = "Transport request outcomes"
            xyChart = {
              dataSets = [{
                plotType = "STACKED_BAR"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"run.googleapis.com/request_count\" resource.type=\"cloud_run_revision\" resource.label.\"service_name\"=\"${var.name_prefix}-transport\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["metric.label.response_code_class"]
                    }
                  }
                }
              }]
              yAxis = { label = "requests/s", scale = "LINEAR" }
            }
          }
        },
        {
          width  = 6
          height = 4
          widget = {
            title = "Ordered subscription backlog age"
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"pubsub.googleapis.com/subscription/oldest_unacked_message_age\" resource.type=\"pubsub_subscription\" resource.label.\"subscription_id\"=\"${local.subscription_name}\""
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_MAX"
                    }
                  }
                }
              }]
              yAxis = { label = "seconds", scale = "LINEAR" }
            }
          }
        },
        {
          width  = 6
          height = 4
          widget = {
            title = "PostgreSQL connections"
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\" resource.type=\"cloudsql_database\" resource.label.\"database_id\"=ends_with(\"${var.name_prefix}-postgres\")"
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_MAX"
                    }
                  }
                }
              }]
              yAxis = { label = "connections", scale = "LINEAR" }
            }
          }
        },
        {
          width  = 6
          height = 4
          widget = {
            title = "Runtime CPU utilization"
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"run.googleapis.com/container/cpu/utilizations\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_PERCENTILE_95"
                      crossSeriesReducer = "REDUCE_MAX"
                      groupByFields      = ["resource.label.service_name", "resource.label.worker_pool_name"]
                    }
                  }
                }
              }]
              yAxis = { label = "utilization", scale = "LINEAR" }
            }
          }
        },
        {
          width  = 12
          height = 5
          widget = {
            title = "Runtime dependency, lease, fence, cancellation, and rollout logs"
            logsPanel = {
              filter = "resource.type=(\"cloud_run_revision\" OR \"cloud_run_worker_pool_revision\") AND resource.labels.location=\"${var.region}\" AND (resource.labels.service_name=\"${var.name_prefix}-transport\" OR resource.labels.worker_pool_name=(\"${var.name_prefix}-relay\" OR \"${var.name_prefix}-agentrun\"))"
            }
          }
        }
      ]
    }
    labels = local.labels
  })
}

output "runtime" {
  description = "Non-secret runtime identifiers and honest qualification labels."
  value = {
    runtime_ready                  = local.runtime_ready
    serving_ready                  = local.serving_ready
    transport_uri                  = try(google_cloud_run_v2_service.transport[0].uri, null)
    public_hostname                = var.public_hostname
    edge_ip_address                = try(google_compute_global_address.edge[0].address, null)
    public_edge_status             = local.public_edge_ready ? "CANDIDATE" : "MISSING"
    production_qualification       = "MISSING"
    six_worker_candidate_qualified = false
    execution_profile_ref          = var.execution_profile_ref
    openrouter_minimax_status      = "MISSING"
  }
}
