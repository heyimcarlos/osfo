locals {
  database_dns_name    = "database.temporal.internal."
  network_probe_script = <<-SCRIPT
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -qq --no-install-recommends jq postgresql-client >/dev/null

    resolved_ip=$(getent ahostsv4 "$${DATABASE_DNS_NAME}" | awk 'NR == 1 { print $1 }')
    test "$${resolved_ip}" = "$${DB_PRIVATE_IP}"

    observed_egress_ip=$(curl --fail --silent --show-error --retry 6 https://api.ipify.org)
    test "$${observed_egress_ip}" = "$${STATIC_EGRESS_IP}"

    access_token=$(curl --fail --silent --show-error \
      -H 'Metadata-Flavor: Google' \
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
      | jq -r .access_token)
    PGPASSWORD="$${access_token}" psql \
      "host=/cloudsql/$${DB_CONNECTION} dbname=osfo user=$${DB_USER} sslmode=disable" \
      --no-psqlrc --tuples-only --command='select 1' | grep -q 1

    printf 'PASS direct_vpc_database_dns_nat\n'
  SCRIPT

  denied_secret_probe_script = <<-SCRIPT
    set -euo pipefail
    denial_file=$(mktemp)
    set +e
    gcloud secrets versions access latest \
      --secret="$${MODEL_SECRET}" --project="$${PROJECT_ID}" \
      >/dev/null 2>"$${denial_file}"
    denial_status=$?
    set -e
    if ((denial_status == 0)); then
      printf 'FAIL unintended_secret_accessor\n' >&2
      exit 1
    fi
    grep -Fq 'PERMISSION_DENIED' "$${denial_file}"
    grep -Fq 'secretmanager.versions.access' "$${denial_file}"
    printf 'PASS unintended_secret_accessor_denied\n'
  SCRIPT
}

resource "google_dns_record_set" "database" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  managed_zone = var.private_dns_zone_name
  name         = local.database_dns_name
  type         = "A"
  ttl          = 30
  rrdatas      = [var.cloud_sql_private_ip]
}

resource "google_cloud_run_v2_job" "network" {
  count = var.enabled ? 1 : 0

  project             = var.project_id
  location            = var.region
  name                = "${var.name_prefix}-network-probe"
  deletion_protection = false
  labels              = var.labels

  template {
    template {
      service_account = var.qualification_service_accounts["network"]
      timeout         = "900s"
      max_retries     = 0

      containers {
        name    = "probe"
        image   = var.probe_image
        command = ["/bin/bash", "-c"]
        args    = [local.network_probe_script]

        env {
          name  = "PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "DATABASE_DNS_NAME"
          value = trimsuffix(local.database_dns_name, ".")
        }
        env {
          name  = "DB_PRIVATE_IP"
          value = var.cloud_sql_private_ip
        }
        env {
          name  = "STATIC_EGRESS_IP"
          value = var.static_egress_ip
        }
        env {
          name  = "DB_CONNECTION"
          value = var.cloud_sql_connection_name
        }
        env {
          name  = "DB_USER"
          value = trimsuffix(var.qualification_service_accounts["network"], ".gserviceaccount.com")
        }
        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [var.cloud_sql_connection_name]
        }
      }

      vpc_access {
        egress = "ALL_TRAFFIC"
        network_interfaces {
          network    = var.network_name
          subnetwork = var.subnetwork_name
          tags       = ["${var.name_prefix}-qualification"]
        }
      }
    }
  }

  depends_on = [google_dns_record_set.database]
}

resource "google_cloud_run_v2_job" "denied_secret" {
  count = var.enabled ? 1 : 0

  project             = var.project_id
  location            = var.region
  name                = "${var.name_prefix}-denied-secret-probe"
  deletion_protection = false
  labels              = var.labels

  template {
    template {
      service_account = var.qualification_service_accounts["denied_secret"]
      timeout         = "300s"
      max_retries     = 0
      containers {
        image   = var.probe_image
        command = ["/bin/bash", "-c"]
        args    = [local.denied_secret_probe_script]
        env {
          name  = "PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "MODEL_SECRET"
          value = var.secret_names["model-adapter"]
        }
      }
    }
  }
}

output "job_names" {
  value = {
    network       = try(google_cloud_run_v2_job.network[0].name, null)
    denied_secret = try(google_cloud_run_v2_job.denied_secret[0].name, null)
  }
}

output "database_dns_name" { value = var.enabled ? local.database_dns_name : null }
