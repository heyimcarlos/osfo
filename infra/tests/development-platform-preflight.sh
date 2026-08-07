#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
varset=${TF_VARSET_FILE:-$repo_root/infra/roots/development/platform/development.tfvars.json}
project_id=$(jq -r '.project_id' "$varset")
region=$(jq -r '.region' "$varset")
report=${PREFLIGHT_REPORT_FILE:-${TMPDIR:-/tmp}/osfo-development-platform-preflight.json}

required_services='artifactregistry.googleapis.com
cloudquotas.googleapis.com
compute.googleapis.com
dns.googleapis.com
pubsub.googleapis.com
run.googleapis.com
secretmanager.googleapis.com
servicedirectory.googleapis.com
servicenetworking.googleapis.com
sqladmin.googleapis.com'
enabled_services=$(gcloud services list --enabled --project="$project_id" --format='value(config.name)')
while IFS= read -r service; do
  rg --fixed-strings --quiet "$service" <<<"$enabled_services"
done <<<"$required_services"
gcloud compute regions describe "$region" --project="$project_id" --format=json >"${TMPDIR:-/tmp}/osfo-region-quotas.json"
gcloud beta quotas info list --project="$project_id" --service=run.googleapis.com --format=json \
  >"${TMPDIR:-/tmp}/osfo-run-quotas.json"
gcloud beta quotas info list --project="$project_id" --service=pubsub.googleapis.com --format=json \
  >"${TMPDIR:-/tmp}/osfo-pubsub-quotas.json"

compute_quota_limit() {
  local metric=$1
  jq -er --arg metric "$metric" '.quotas[] | select(.metric == $metric) | .limit' \
    "${TMPDIR:-/tmp}/osfo-region-quotas.json"
}

quota_requirement() {
  jq -er --arg key "$1" '.quota_requirements[$key]' "$varset"
}

regional_quota_limit() {
  local file=$1
  local quota_id=$2
  jq -er --arg quota_id "$quota_id" --arg region "$region" '
    .[]
    | select(.quotaId == $quota_id)
    | .dimensionsInfos[]
    | select((.dimensions.region // "") == $region or ((.applicableLocations // []) | index($region)))
    | .details.value
  ' "$file"
}

static_required=$(quota_requirement static_external_ipv4_addresses)
psc_required=$(quota_requirement psc_forwarding_rules)
run_cpu_required=$(quota_requirement cloud_run_cpu)
pubsub_required=$(quota_requirement pubsub_publisher_kb_per_minute)
static_limit=$(compute_quota_limit STATIC_ADDRESSES)
psc_limit=$(compute_quota_limit PSC_INTERNAL_LB_FORWARDING_RULES)
run_cpu_available_milli=$(regional_quota_limit "${TMPDIR:-/tmp}/osfo-run-quotas.json" CpuAllocPerProjectRegion)
run_cpu_limit=$((run_cpu_available_milli / 1000))
pubsub_limit=$(regional_quota_limit "${TMPDIR:-/tmp}/osfo-pubsub-quotas.json" publisherPerMinutePerProjectPerRegion)

quota_satisfies() {
  jq -en --argjson limit "$1" --argjson required "$2" '$limit >= $required' >/dev/null
}

quota_satisfies "$static_limit" "$static_required"
quota_satisfies "$psc_limit" "$psc_required"
quota_satisfies "$run_cpu_limit" "$run_cpu_required"
quota_satisfies "$pubsub_limit" "$pubsub_required"

jq -n \
  --arg project_id "$project_id" \
  --arg region "$region" \
  --argjson static_required "$static_required" \
  --argjson static_limit "$static_limit" \
  --argjson psc_required "$psc_required" \
  --argjson psc_limit "$psc_limit" \
  --argjson run_cpu_required "$run_cpu_required" \
  --argjson run_cpu_limit "$run_cpu_limit" \
  --argjson pubsub_required "$pubsub_required" \
  --argjson pubsub_limit "$pubsub_limit" \
  '{schema_version: 1, project_id: $project_id, region: $region, checks: {
    static_external_ipv4_addresses: {status: "PASS", required: $static_required, limit: $static_limit},
    psc_forwarding_rules: {status: "PASS", required: $psc_required, limit: $psc_limit},
    cloud_run_cpu: {status: "PASS", required: $run_cpu_required, limit: $run_cpu_limit},
    pubsub_publisher_kb_per_minute: {status: "PASS", required: $pubsub_required, limit: $pubsub_limit}
  }}' >"$report"

printf 'PASS: required services and all reviewed quota inputs (%s)\n' "$report"
