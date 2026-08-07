#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
varset=${TF_VARSET_FILE:-$repo_root/infra/roots/development/platform/development.tfvars.json}
report_file=${1:?absence report file is required}
project_id=$(jq -r '.project_id' "$varset")
region=$(jq -r '.region' "$varset")
name_prefix=$(jq -r '.name_prefix' "$varset")
artifact_bucket=$(jq -r '.artifact_bucket_name' "$varset")
repository=$(jq -r '.artifact_registry_repository_id' "$varset")
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

assert_absent() {
  local label=$1
  local needle=$2
  shift 2
  local listing_file="$scratch/$label.list"

  if ! "$@" >"$listing_file" 2>"$scratch/$label.error"; then
    printf 'FAIL: provider lookup for %s failed closed\n' "$label" >&2
    cat "$scratch/$label.error" >&2
    return 1
  fi
  if sed 's#.*/##' "$listing_file" | grep -Fx -- "$needle" >/dev/null; then
    printf 'FAIL: provider lookup found disposable %s %s\n' "$label" "$needle" >&2
    return 1
  fi
}

assert_absent cloud_sql "$name_prefix-postgres" \
  gcloud sql instances list --project="$project_id" --format='value(name)'

export CLOUDSDK_API_ENDPOINT_OVERRIDES_PUBSUB="https://$region-pubsub.googleapis.com/"
assert_absent pubsub_topic "$name_prefix-agentruns" \
  gcloud pubsub topics list --project="$project_id" --format='value(name)'
assert_absent pubsub_subscription "$name_prefix-agentruns" \
  gcloud pubsub subscriptions list --project="$project_id" --format='value(name)'
unset CLOUDSDK_API_ENDPOINT_OVERRIDES_PUBSUB

for identity in transport relay agentrun temporal migration reconciliation; do
  assert_absent "service_account_$identity" "$name_prefix-$identity@$project_id.iam.gserviceaccount.com" \
    gcloud iam service-accounts list --project="$project_id" --format='value(email)'
done

for secret in model-adapter temporal-cloud; do
  assert_absent "secret_${secret//-/_}" "$name_prefix-$secret" \
    gcloud secrets list --project="$project_id" --format='value(name)'
done

assert_absent artifact_registry "$repository" \
  gcloud artifacts repositories list --project="$project_id" --location="$region" \
  --format='value(name)'
assert_absent artifact_bucket "$artifact_bucket" \
  gcloud storage buckets list --project="$project_id" --format='value(name)'

for job in network-probe temporal-secret-probe denied-secret-probe; do
  assert_absent "run_job_${job//-/_}" "$name_prefix-$job" \
    gcloud run jobs list --project="$project_id" --region="$region" --format='value(name)'
done

assert_absent private_dns_record database.temporal.internal. \
  gcloud dns record-sets list --project="$project_id" --zone="$name_prefix-private" \
  --format='value(name)'

jq -n --arg project_id "$project_id" --arg region "$region" '{
  schema_version: 1,
  project_id: $project_id,
  region: $region,
  checks: {
    cloud_sql: "PASS",
    pubsub_topic_and_subscription: "PASS",
    runtime_service_accounts: "PASS",
    secrets: "PASS",
    artifact_registry: "PASS",
    artifact_bucket: "PASS",
    qualification_jobs: "PASS",
    disposable_private_dns_record: "PASS"
  }
}' >"$report_file"

printf 'PASS: negative provider lookups confirm disposable resources are absent\n'
