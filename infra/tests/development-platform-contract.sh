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
rg --fixed-strings --quiet 'allowed_persistence_regions = [var.region]' \
  infra/modules/command-buffer/main.tf
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
rg --fixed-strings --quiet 'gcloud storage cp "$scratch/artifact" "$artifact_uri"' \
  infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'temporal_private_service_connect' infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'temporal_lookup_status=$?' infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'FAIL: Temporal PSC forwarding rule lookup failed closed' \
  infra/tests/development-platform-smoke.sh
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
rg --fixed-strings --quiet 'artifact_immutability_enforced_by_iam: "PASS"' \
  infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'artifact_unconditional_overwrite_denied_by_iam: "PASS"' \
  infra/tests/development-platform-smoke.sh
if rg --fixed-strings --quiet 'artifact_precondition_rejected_second_generation' \
  infra/tests/development-platform-smoke.sh; then
  printf 'unconditional IAM rejection must not be mislabeled as a precondition check\n' >&2
  exit 1
fi
rg --fixed-strings --quiet "grep -Fq 'storage.objects.delete'" \
  infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'probe_toolchain_determinism: "MISSING"' \
  infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'development-platform-absent.sh' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'development-platform-audit.sh' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'gcloud storage buckets describe "gs://$artifact_bucket"' \
  infra/tests/development-platform-absent.sh
if rg --fixed-strings --quiet 'gcloud storage buckets list' \
  infra/tests/development-platform-absent.sh; then
  printf 'artifact absence must use its exact scoped bucket permission\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'qualification_subscription "$name_prefix-ordering-"' \
  infra/tests/development-platform-absent.sh
rg --fixed-strings --quiet 'diff-index --quiet HEAD --' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'state_status=$?' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'destroy_plan_bindings: $destroy_plan_bindings' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet \
  'DEVELOPMENT_LIFECYCLE_RUN_ID is required and must be unique per lifecycle attempt' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'FAIL: lifecycle run identifier has already been used' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'lifecycle_preflight_status=$?' \
  infra/tests/development-platform-live.sh
if rg --fixed-strings --quiet 'existing-lifecycle-envelope.json' \
  infra/tests/development-platform-live.sh; then
  printf 'create path must never accept a reused lifecycle run identifier\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'lifecycle_evidence_linkage: $lifecycle_envelope_status' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'create_plan_binding_sha256: $create_plan_binding_sha256' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'second_plan_binding_sha256: $second_plan_binding_sha256' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'managed_report_sha256: $managed_report_sha256' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet '.source.variable_set_sha256 == $variable_set_sha256' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet '.source.image_digests_sha256 == $image_digests_sha256' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'validate_saved_plan_binding "$create_binding" lifecycle-create' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'validate_saved_plan_binding "$second_binding" lifecycle-second' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'managed smoke report does not match lifecycle envelope digest' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'MISSING: lifecycle ended before its evidence envelope was stored' \
  infra/tests/development-platform-live.sh
if rg --fixed-strings --quiet 'state-list.error' infra/tests/development-platform-live.sh; then
  printf 'state-list diagnostics must not dirty the reviewed source tree\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'qualification: "PARTIAL"' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet \
  'retained_core_network_and_private_services_baseline: "PASS"' \
  infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'retained_temporal_psc_baseline: "MISSING"' \
  infra/tests/development-platform-live.sh
if rg --fixed-strings --quiet 'retained_environment_baseline: "PASS"' \
  infra/tests/development-platform-live.sh; then
  printf 'core retained-baseline proof must not imply unverified Temporal PSC\n' >&2
  exit 1
fi
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
rg --fixed-strings --quiet 'lifecycle=MISSING' infra/tests/development-platform-live.sh
rg --fixed-strings --quiet 'quota_requirement static_external_ipv4_addresses' infra/tests/development-platform-preflight.sh
rg --fixed-strings --quiet 'quota_requirement pubsub_publisher_kb_per_minute' infra/tests/development-platform-preflight.sh
rg --fixed-strings --quiet 'run.googleapis.com' infra/tests/development-platform-preflight.sh
rg --fixed-strings --quiet 'managed_ordered_subscription_configuration: "PASS"' \
  infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet 'gcloud pubsub subscriptions describe "$subscription"' \
  infra/tests/development-platform-smoke.sh
rg --fixed-strings --quiet '.messageStoragePolicy.allowedPersistenceRegions == [$region]' \
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

project_id=$(jq -r '.project_id' "$root/development.tfvars.json")
artifact_bucket=$(jq -r '.artifact_bucket_name' "$root/development.tfvars.json")
if [[ "$artifact_bucket" != "osfo-development-artifacts-${project_id##*-}" ]]; then
  printf 'foundation-derived and disposable platform artifact bucket names must match\n' >&2
  exit 1
fi

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
if grep -Eq 'roles/(compute.networkAdmin|servicenetworking.networksAdmin|storage.admin)' \
  <<<"$platform_roles"; then
  printf 'platform identity must not administer the retained network or artifact objects\n' >&2
  exit 1
fi
if grep -Fq 'roles/dns.admin' <<<"$platform_roles"; then
  printf 'platform identity must not administer the retained private DNS zone\n' >&2
  exit 1
fi
if ! grep -Fq 'roles/compute.networkViewer' <<<"$platform_roles"; then
  printf 'platform identity is missing read-only retained-network authority\n' >&2
  exit 1
fi
network_use=$(sed -n \
  '/resource "google_compute_subnetwork_iam_member" "development_platform_network_user"/,/^}/p' \
  infra/roots/foundation/main.tf)
for exact_network_binding in \
  'subnetwork = module.development_environment_baseline.subnetwork_id' \
  'role       = "roles/compute.networkUser"' \
  'google_service_account.terraform["development-platform"].email'; do
  grep -Fq "$exact_network_binding" <<<"$network_use"
done
probe_act_as=$(sed -n \
  '/resource "google_service_account_iam_member" "development_platform_probe_act_as"/,/^}/p' \
  infra/roots/foundation/main.tf)
if [[ $(rg --fixed-strings 'roles/iam.serviceAccountUser' infra/roots/foundation/main.tf | wc -l) != 1 ]] \
  || ! grep -Fq 'for_each = google_service_account.development_qualification' <<<"$probe_act_as" \
  || ! grep -Fq 'service_account_id = each.value.name' <<<"$probe_act_as" \
  || ! grep -Fq 'google_service_account.terraform["development-platform"].email' <<<"$probe_act_as"; then
  printf 'platform actAs must target only the reviewed qualification identities\n' >&2
  exit 1
fi
secret_access=$(sed -n \
  '/resource "google_project_iam_member" "development_secret_access"/,/resource "google_service_account" "development_runtime"/p' \
  infra/roots/foundation/main.tf)
if grep -Fq 'development_qualification' <<<"$secret_access"; then
  printf 'qualification identities must not receive secret payload access\n' >&2
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
if grep -Fq 'iam.serviceAccounts.actAs' <<<"$platform_custom_roles"; then
  printf 'platform custom roles must not permit service-account impersonation\n' >&2
  exit 1
fi
platform_storage_role=$(sed -n \
  '/resource "google_project_iam_custom_role" "platform_storage_manager"/,/resource "google_project_iam_custom_role" "platform_bucket_creator"/p' \
  infra/roots/foundation/main.tf)
for permission in storage.buckets.delete storage.objects.create storage.objects.get storage.objects.list; do
  grep -Fq "$permission" <<<"$platform_storage_role"
done
for forbidden_permission in storage.buckets.create storage.buckets.list storage.buckets.update storage.objects.delete; do
  if grep -Fq "$forbidden_permission" <<<"$platform_storage_role"; then
    printf 'platform scoped storage role contains unsafe permission %s\n' \
      "$forbidden_permission" >&2
    exit 1
  fi
done
rg --fixed-strings --quiet 'resource "google_project_iam_custom_role" "platform_bucket_creator"' \
  infra/roots/foundation/main.tf
bucket_creator_role=$(sed -n \
  '/resource "google_project_iam_custom_role" "platform_bucket_creator"/,/resource "google_project_iam_custom_role" "platform_dns_record_manager"/p' \
  infra/roots/foundation/main.tf)
if [[ $(grep -Fc 'storage.buckets.create' <<<"$bucket_creator_role") != 1 ]] \
  || grep -Eq 'storage\.(buckets\.(delete|update)|objects\.)' <<<"$bucket_creator_role"; then
  printf 'project-level bucket creator must grant only bucket creation\n' >&2
  exit 1
fi
platform_storage_binding=$(sed -n \
  '/resource "google_project_iam_member" "platform_storage_manager"/,/resource "google_project_iam_member" "platform_bucket_creator"/p' \
  infra/roots/foundation/main.tf)
grep -Fq "resource.name == 'projects/_/buckets/\${local.development_artifact_bucket_name}'" \
  <<<"$platform_storage_binding"
grep -Fq "resource.name.startsWith('projects/_/buckets/\${local.development_artifact_bucket_name}/objects/')" \
  <<<"$platform_storage_binding"
rg --fixed-strings --quiet 'resource "google_project_iam_custom_role" "platform_dns_record_manager"' \
  infra/roots/foundation/main.tf
dns_binding=$(sed -n \
  '/resource "google_dns_managed_zone_iam_member" "development_platform_database_record"/,/resource "google_project_iam_member" "development_artifact_cleaner"/p' \
  infra/roots/foundation/main.tf)
# The Terraform expression is intentionally matched as a literal string.
# shellcheck disable=SC2016
for exact_dns_boundary in \
  'managed_zone = "${var.development_environment_baseline.name_prefix}-private"' \
  "resource.type == 'dns.googleapis.com/ResourceRecordSet'" \
  "resource.name.endsWith('/rrsets/database.temporal.internal./A')"; do
  grep -Fq "$exact_dns_boundary" <<<"$dns_binding"
done
rg --fixed-strings --quiet 'resource "google_project_iam_custom_role" "development_artifact_cleaner"' \
  infra/roots/foundation/main.tf
rg --fixed-strings --quiet \
  "resource.name.startsWith('projects/_/buckets/\${local.development_artifact_bucket_name}/objects/')" \
  infra/roots/foundation/main.tf
rg --fixed-strings --quiet 'infra/tests/development-platform-prepare-cleanup.sh' \
  .github/workflows/terraform.yml .github/workflows/development-platform-recovery.yml

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
rg --fixed-strings --quiet 'refs/heads/main' .github/workflows/terraform.yml
if rg --fixed-strings --quiet 'refs/heads/codex/provision-development-platform' \
  .github/workflows/terraform.yml .github/workflows/development-platform-recovery.yml; then
  printf 'privileged workflows must not trust a mutable feature branch\n' >&2
  exit 1
fi
rg --fixed-strings --quiet "assertion.ref == 'refs/heads/main'" infra/roots/foundation/main.tf
rg --fixed-strings --quiet 'DEVELOPMENT_PLATFORM_CLEANUP_ONLY: "1"' .github/workflows/terraform.yml
rg --fixed-strings --quiet \
  'DEVELOPMENT_LIFECYCLE_RUN_ID: ${{ github.run_id }}-${{ github.run_attempt }}' \
  .github/workflows/terraform.yml
rg --fixed-strings --quiet \
  'DEVELOPMENT_LIFECYCLE_RUN_ID: ${{ needs.authorize.outputs.lifecycle_run_id }}' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet 'always()' .github/workflows/terraform.yml
rg --fixed-strings --quiet "needs.static.result == 'success'" .github/workflows/terraform.yml
rg --fixed-strings --quiet "'terraform-development-platform'" .github/workflows/terraform.yml
rg --fixed-strings --quiet 'group: terraform-development-platform' \
  .github/workflows/development-platform-recovery.yml
if [[ $(rg --fixed-strings 'queue: max' \
  .github/workflows/terraform.yml .github/workflows/development-platform-recovery.yml | wc -l) != 2 ]]; then
  printf 'development state workflows must preserve every pending recovery run\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'workflows: [Terraform]' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet 'cron: "43 9 * * *"' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet 'Recovery for Terraform run {0} attempt {1}' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet 'PASS: scheduled janitor found no abandoned protected lifecycle marker' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet 'FAIL: scheduled janitor source lacks exact successful static proof' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet 'development-platform-recovery.yml/runs?status=success' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet \
  'development-cleanup-complete-${{ needs.authorize.outputs.marker_id }}' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet 'marker_id=%s-%s' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet \
  'runs/$run_id/attempts/$run_attempt/jobs?per_page=100' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet \
  'runs/$TRIGGER_RUN_ID/attempts/$TRIGGER_RUN_ATTEMPT/jobs?per_page=100' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet \
  'runs/$source_run_id/attempts/$source_run_attempt/jobs?per_page=100' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet \
  'runs/$recovery_run_id/attempts/$recovery_run_attempt/jobs?per_page=100' \
  .github/workflows/development-platform-recovery.yml
if rg --fixed-strings --quiet 'jobs?filter=all' \
  .github/workflows/development-platform-recovery.yml; then
  printf 'recovery authorization must never combine jobs across run attempts\n' >&2
  exit 1
fi
rg --fixed-strings --quiet '.name == "development-cleanup" and .conclusion == "success"' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet \
  '.name == "static" and .conclusion == "success"' \
  .github/workflows/development-platform-recovery.yml
rg --fixed-strings --quiet \
  '.name == "development-authorization" and .conclusion == "success"' \
  .github/workflows/development-platform-recovery.yml
if [[ $(rg --fixed-strings \
  '.name == "development-configuration" and .conclusion == "success"' \
  .github/workflows/development-platform-recovery.yml | wc -l) != 2 ]]; then
  printf 'automatic and scheduled recovery must require complete protected configuration\n' >&2
  exit 1
fi
if [[ $(rg --fixed-strings 'ref: ${{ needs.authorize.outputs.source_ref }}' \
  .github/workflows/development-platform-recovery.yml | wc -l) != 2 ]]; then
  printf 'durable recovery must use the exact protected lifecycle source commit\n' >&2
  exit 1
fi
if [[ $(rg --fixed-strings 'needs: [static, drift-configuration]' \
  .github/workflows/terraform.yml | wc -l) != 2 ]]; then
  printf 'scheduled drift must validate reviewed source before OIDC authentication\n' >&2
  exit 1
fi
if rg --fixed-strings --quiet 'development-platform-workflow' .github/workflows/terraform.yml; then
  printf 'all development platform state operations must share the global concurrency group\n' >&2
  exit 1
fi
if rg --fixed-strings --quiet 'development-platform-root-job' .github/workflows/terraform.yml; then
  printf 'development root operations must not use a second job-level state lock\n' >&2
  exit 1
fi

printf 'PASS: development platform topology, reviewed inputs, and teardown boundaries\n'
