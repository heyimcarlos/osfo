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
rg --fixed-strings --quiet 'authorized_secret_version_access: "MISSING"' \
  infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'google_cloud_run_v2_job' infra/modules/qualification-probe/main.tf
rg --fixed-strings --quiet 'egress = "ALL_TRAFFIC"' infra/modules/qualification-probe/main.tf
rg --fixed-strings --quiet 'private_database_connection_from_direct_vpc: "PASS"' infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'static_nat_traffic_from_direct_vpc: "PASS"' infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'exact_permission_denied_secret_payload_access: "PASS"' \
  infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet "grep -Fq 'PERMISSION_DENIED'" infra/modules/qualification-probe/main.tf
rg --fixed-strings --quiet "grep -Fq 'secretmanager.versions.access'" \
  infra/modules/qualification-probe/main.tf
rg --fixed-strings --quiet 'artifact_immutability_enforced_by_iam: "MISSING"' \
  infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'probe_toolchain_determinism: "MISSING"' \
  infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'development-platform-absent.sh' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'development-platform-audit.sh' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'qualification_subscription "$name_prefix-ordering-"' \
  infra/tests/development-platform-absent.sh
rg --fixed-strings --quiet 'diff-index --quiet HEAD --' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'state_status=$?' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'destroy_plan_bindings: $destroy_plan_bindings' \
  infra/tests/development-platform-live.sh
if rg --fixed-strings --quiet 'state-list.error' infra/tests/development-platform-live.sh; then
  printf 'state-list diagnostics must not dirty the reviewed source tree\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'exact_disposable_destroy: "PASS"' infra/tests/development-platform-live.sh
# The literal shell variable references are part of the implementation contract.
# shellcheck disable=SC2016
for retained_lookup in \
  'addresses describe "$name_prefix-egress"' \
  'routers describe "$name_prefix-router"' \
  'firewall-rules describe "$name_prefix-deny-ingress"' \
  'firewall-rules describe "$name_prefix-allow-egress"' \
  'addresses describe "$name_prefix-private-services"' \
  'services vpc-peerings list'; do
  rg --fixed-strings --quiet "$retained_lookup" infra/tests/development-platform-live.sh
done
rg --fixed-strings --quiet 'trap cleanup_on_exit EXIT' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet "exit 130' INT TERM" infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'quota_requirement static_external_ipv4_addresses' infra/tests/development-platform-preflight.sh
rg --fixed-strings --quiet 'quota_requirement pubsub_publisher_kb_per_minute' infra/tests/development-platform-preflight.sh
rg --fixed-strings --quiet 'run.googleapis.com' infra/tests/development-platform-preflight.sh
rg --fixed-strings --quiet 'managed_ordered_subscription_configuration: "PASS"' \
  infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'gcloud pubsub subscriptions describe "$subscription"' \
  infra/tests/development-platform-smoke.sh

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

if rg --fixed-strings --quiet 'roles/secretmanager.admin' infra/roots/foundation/main.tf; then
  printf 'platform identity must not have project-wide secret payload access\n' >&2
  exit 1
fi

if rg --fixed-strings --quiet 'roles/iam.serviceAccountTokenCreator' infra/modules/data-authority/main.tf; then
  printf 'platform identity must not mint runtime identity tokens\n' >&2
  exit 1
fi

rg --fixed-strings --quiet 'resource "google_project_iam_custom_role" "platform_service_consumer"' \
  infra/roots/foundation/main.tf
rg --fixed-strings --quiet '"serviceusage.services.use"' infra/roots/foundation/main.tf
rg --fixed-strings --quiet 'resource "google_service_account" "development_runtime"' \
  infra/roots/foundation/main.tf
rg --fixed-strings --quiet 'output "development_runtime_service_accounts"' \
  infra/roots/foundation/outputs.tf
rg --fixed-strings --quiet 'resource "google_project_iam_member" "development_runtime_cloud_sql"' \
  infra/roots/foundation/main.tf
rg --fixed-strings --quiet 'resource "google_service_account" "development_qualification"' \
  infra/roots/foundation/main.tf
rg --fixed-strings --quiet 'resource "google_service_account_iam_member" "development_platform_probe_act_as"' \
  infra/roots/foundation/main.tf
rg --fixed-strings --quiet '"roles/cloudsql.client"' infra/roots/foundation/main.tf
rg --fixed-strings --quiet '"roles/cloudsql.instanceUser"' infra/roots/foundation/main.tf
rg --fixed-strings --quiet '/versions/' infra/roots/foundation/main.tf
if rg --quiet 'resource "google_(project|service_account)_iam_member"' \
  infra/modules/data-authority/main.tf; then
  printf 'disposable platform root must not mutate project or service-account IAM\n' >&2
  exit 1
fi
platform_roles=$(sed -n '/platform_project_roles =/,/platform_role_bindings =/p' \
  infra/roots/foundation/main.tf)
if ! grep -Fq 'roles/iam.serviceAccountViewer' <<<"$platform_roles"; then
  printf 'platform identity must be able to verify retained service accounts\n' >&2
  exit 1
fi
if grep -Eq 'roles/(iam.serviceAccountAdmin|resourcemanager.projectIamAdmin|serviceusage.serviceUsageConsumer)' \
  <<<"$platform_roles"; then
  printf 'platform identity must not administer project or service-account IAM\n' >&2
  exit 1
fi
secret_access=$(sed -n \
  '/resource "google_project_iam_member" "development_secret_access"/,/resource "google_service_account" "development_runtime"/p' \
  infra/roots/foundation/main.tf)
if grep -Fq 'development_qualification' <<<"$secret_access"; then
  printf 'qualification identities must not receive secret payload access\n' >&2
  exit 1
fi
if rg --fixed-strings --quiet 'development_platform_job_act_as' \
  infra/roots/foundation/main.tf; then
  printf 'platform identity must not impersonate secret-bearing runtime identities\n' >&2
  exit 1
fi
platform_custom_roles=$(sed -n \
  '/resource "google_project_iam_custom_role" "platform_secret_manager"/,/resource "google_project" "environment"/p' \
  infra/roots/foundation/main.tf)
if grep -Fq 'resourcemanager.projects.setIamPolicy' <<<"$platform_custom_roles"; then
  printf 'platform identity must not mutate project IAM\n' >&2
  exit 1
fi
if grep -Fq 'secretmanager.secrets.setIamPolicy' <<<"$platform_custom_roles"; then
  printf 'platform identity must not mutate secret IAM\n' >&2
  exit 1
fi

jq -e '
  . as $config
  | ($config.runtime_service_accounts | keys) == [
    "agentrun", "migration", "reconciliation", "relay", "temporal", "transport"
  ]
  and all($config.runtime_service_accounts | to_entries[];
    .value == "\($config.name_prefix)-\(.key)@\($config.project_id).iam.gserviceaccount.com")
' "$root/development.tfvars.json" >/dev/null

jq -e '
  . as $config
  | ($config.qualification_service_accounts | keys) == [
    "denied_secret", "network"
  ]
  and all($config.qualification_service_accounts | to_entries[];
    .value | startswith("\($config.name_prefix)-qual-")
    and endswith("@\($config.project_id).iam.gserviceaccount.com"))
' "$root/development.tfvars.json" >/dev/null

rg --fixed-strings --quiet 'foundation-drift' .github/workflows/terraform.yml
rg --fixed-strings --quiet 'development-platform-absent.sh' .github/workflows/terraform.yml
rg --fixed-strings --quiet 'Report missing protected configuration' .github/workflows/terraform.yml
rg --fixed-strings --quiet 'Require an explicitly reviewed lifecycle ref' .github/workflows/terraform.yml
rg --fixed-strings --quiet 'refs/heads/codex/provision-development-platform' .github/workflows/terraform.yml

printf 'PASS: development platform topology, reviewed inputs, and teardown boundaries\n'
