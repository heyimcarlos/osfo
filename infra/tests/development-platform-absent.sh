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

assert_absent_prefix() {
  local label=$1
  local prefix=$2
  shift 2
  local listing_file="$scratch/$label.list"

  if ! "$@" >"$listing_file" 2>"$scratch/$label.error"; then
    printf 'FAIL: provider lookup for %s failed closed\n' "$label" >&2
    cat "$scratch/$label.error" >&2
    return 1
  fi
  if sed 's#.*/##' "$listing_file" | grep -F -- "$prefix" >/dev/null; then
    printf 'FAIL: provider lookup found disposable %s with prefix %s\n' \
      "$label" "$prefix" >&2
    return 1
  fi
}

assert_present() {
  local label=$1
  local needle=$2
  shift 2
  local listing_file="$scratch/$label.list"

  if ! "$@" >"$listing_file" 2>"$scratch/$label.error"; then
    printf 'FAIL: provider lookup for retained %s failed closed\n' "$label" >&2
    cat "$scratch/$label.error" >&2
    return 1
  fi
  if ! sed 's#.*/##' "$listing_file" | grep -Fx -- "$needle" >/dev/null; then
    printf 'FAIL: provider lookup did not find retained %s %s\n' "$label" "$needle" >&2
    return 1
  fi
}

assert_exact_absent() {
  local label=$1
  shift
  local lookup_status=0

  "$@" >"$scratch/$label.describe" 2>"$scratch/$label.error" || lookup_status=$?
  if ((lookup_status == 0)); then
    printf 'FAIL: exact provider lookup found disposable %s\n' "$label" >&2
    return 1
  fi
  if ! grep -Eqi '404|not found|does not exist' "$scratch/$label.error"; then
    printf 'FAIL: exact provider lookup for %s failed closed\n' "$label" >&2
    cat "$scratch/$label.error" >&2
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
assert_absent_prefix qualification_subscription "$name_prefix-ordering-" \
  gcloud pubsub subscriptions list --project="$project_id" --format='value(name)'
unset CLOUDSDK_API_ENDPOINT_OVERRIDES_PUBSUB

while IFS=$'\t' read -r identity email; do
  assert_present "service_account_$identity" "$email" \
    gcloud iam service-accounts list --project="$project_id" --format='value(email)'
done < <(jq -r '.runtime_service_accounts | to_entries[] | [.key, .value] | @tsv' "$varset")

for identity in migration reconciliation; do
  email="$name_prefix-$identity@$project_id.iam.gserviceaccount.com"
  assert_present "service_account_dormant_$identity" "$email" \
    gcloud iam service-accounts list --project="$project_id" --format='value(email)'

  if ! gcloud iam service-accounts describe "$email" --project="$project_id" \
    --format=json >"$scratch/service-account-dormant-$identity.json" \
    2>"$scratch/service-account-dormant-$identity.error"; then
    printf 'FAIL: provider lookup for dormant service account %s failed closed\n' \
      "$identity" >&2
    cat "$scratch/service-account-dormant-$identity.error" >&2
    exit 1
  fi
  jq -e --arg email "$email" '.email == $email and .disabled == true' \
    "$scratch/service-account-dormant-$identity.json" >/dev/null || {
    printf 'FAIL: dormant service account %s is not disabled\n' "$identity" >&2
    exit 1
  }

  if ! gcloud iam service-accounts get-iam-policy "$email" \
    --project="$project_id" --format=json \
    >"$scratch/service-account-dormant-$identity-policy.json" \
    2>"$scratch/service-account-dormant-$identity-policy.error"; then
    printf 'FAIL: provider lookup for dormant service account %s policy failed closed\n' \
      "$identity" >&2
    cat "$scratch/service-account-dormant-$identity-policy.error" >&2
    exit 1
  fi
  jq -e '(.bindings // []) | length == 0' \
    "$scratch/service-account-dormant-$identity-policy.json" >/dev/null || {
    printf 'FAIL: dormant service account %s retains an actAs or impersonation binding\n' \
      "$identity" >&2
    exit 1
  }
done

while IFS=$'\t' read -r identity email; do
  assert_present "qualification_service_account_$identity" "$email" \
    gcloud iam service-accounts list --project="$project_id" --format='value(email)'
done < <(jq -r '.qualification_service_accounts | to_entries[] | [.key, .value] | @tsv' "$varset")

for secret in model-adapter temporal-cloud authorized-secret-proof; do
  assert_absent "secret_${secret//-/_}" "$name_prefix-$secret" \
    gcloud secrets list --project="$project_id" --format='value(name)'
done

assert_absent artifact_registry "$repository" \
  gcloud artifacts repositories list --project="$project_id" --location="$region" \
  --format='value(name)'
assert_exact_absent artifact_bucket \
  gcloud storage buckets describe "gs://$artifact_bucket" --project="$project_id"

for job in network-probe temporal-secret-probe denied-secret-probe authorized-secret-probe; do
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
    qualification_subscriptions: "PASS",
    retained_runtime_service_accounts: "PASS",
    protected_dormant_service_accounts_disabled: "PASS",
    protected_dormant_service_account_iam_bindings_absent: "PASS",
    retained_qualification_service_accounts: "PASS",
    secrets: "PASS",
    artifact_registry: "PASS",
    artifact_bucket: "PASS",
    qualification_jobs: "PASS",
    disposable_private_dns_record: "PASS"
  }
}' >"$report_file"

printf 'PASS: negative provider lookups confirm disposable resources are absent\n'
