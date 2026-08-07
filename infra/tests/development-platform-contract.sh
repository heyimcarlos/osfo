#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

root=infra/roots/development/platform

for module in environment-baseline data-authority command-buffer; do
  test -f "infra/modules/$module/main.tf"
done
rg --fixed-strings --quiet 'module "development_environment_baseline"' \
  infra/roots/foundation/main.tf
for module in data-authority command-buffer; do
  rg --fixed-strings --quiet "module \"${module//-/_}\"" "$root/main.tf"
done

rg --quiet 'enable_message_ordering\s*=\s*true' infra/modules/command-buffer/main.tf
rg --quiet 'message_retention_duration\s*=\s*var.message_retention_duration' infra/modules/command-buffer/main.tf
rg --fixed-strings --quiet 'cloudsql.iam_authentication' infra/modules/data-authority/main.tf
rg --fixed-strings --quiet 'ipv4_enabled    = false' infra/modules/data-authority/main.tf
rg --quiet 'availability_type\s*=\s*"ZONAL"' infra/modules/data-authority/main.tf
rg --quiet 'uniform_bucket_level_access\s*=\s*true' infra/modules/data-authority/main.tf
rg --quiet 'public_access_prevention\s*=\s*"enforced"' infra/modules/data-authority/main.tf
rg --quiet 'force_destroy\s*=\s*true' infra/modules/data-authority/main.tf
rg --fixed-strings --quiet 'google_compute_router_nat' infra/modules/environment-baseline/main.tf
rg --fixed-strings --quiet 'google_compute_forwarding_rule' infra/modules/environment-baseline/main.tf
rg --fixed-strings --quiet 'google_dns_managed_zone' infra/modules/environment-baseline/main.tf
rg --fixed-strings --quiet 'google_compute_firewall' infra/modules/environment-baseline/main.tf
rg --fixed-strings --quiet 'gcloud sql instances describe' infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'gcloud pubsub topics publish' infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'gcloud storage cp --if-generation-match=0' infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'temporal_private_service_connect' infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'authorized_secret_version_access' infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'exact_disposable_destroy: "PASS"' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'trap cleanup_on_exit EXIT' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'quota_requirement static_external_ipv4_addresses' infra/tests/development-platform-preflight.sh
rg --fixed-strings --quiet 'quota_requirement pubsub_publisher_kb_per_minute' infra/tests/development-platform-preflight.sh

jq -e '
  .project_id != null
  and .region == "us-east4"
  and .enable_managed_platform == true
  and .operating_contract.agentrun_worker_count != null
  and .operating_contract.agentrun_streams_per_worker != null
  and .operating_contract.agentrun_execution_slots_per_worker != null
  and .operating_contract.agentrun_db_pool_connections != null
  and (.quota_requirements | keys | sort) == [
    "cloud_run_cpu",
    "psc_forwarding_rules",
    "pubsub_publisher_kb_per_minute",
    "static_external_ipv4_addresses"
  ]
' "$root/development.tfvars.json" >/dev/null

if rg --quiet --glob '*.tf' 'secret_data|google_secret_manager_secret_version' "$root" infra/modules; then
  printf 'secret payloads must not enter Terraform\n' >&2
  exit 1
fi

printf 'PASS: development platform topology, reviewed inputs, and teardown boundaries\n'
