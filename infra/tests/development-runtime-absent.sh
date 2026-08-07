#!/usr/bin/env bash

set -euo pipefail

project_id=${GCP_DEVELOPMENT_PROJECT_ID:?GCP_DEVELOPMENT_PROJECT_ID is required}
region=${GCP_REGION:-us-east4}
prefix=${OSFO_NAME_PREFIX:-osfo-dev}
residue=0

fail_identity() {
  printf 'FAIL: unable to verify exact development project identity and authentication\n' >&2
  exit 1
}

require_empty() {
  local label=$1
  shift
  local output
  if ! output=$("$@" 2>/dev/null); then
    printf 'FAIL: provider list for %s failed closed\n' "$label" >&2
    residue=1
  elif [[ -n "$output" ]]; then
    printf 'FAIL: residual %s\n' "$label" >&2
    residue=1
  fi
}

auth_document=$(gcloud auth list \
  --filter='status:ACTIVE' \
  --format='json(account,status)' 2>/dev/null) || fail_identity
if ! jq -e '
  type == "array"
  and length == 1
  and .[0].status == "ACTIVE"
  and (.[0].account | type == "string" and test("^[^[:space:]]+$"))
' <<<"$auth_document" >/dev/null; then
  fail_identity
fi
project_document=$(gcloud projects describe "$project_id" \
  --format='json(projectId)' 2>/dev/null) || fail_identity
if ! jq -e --arg project_id "$project_id" '
  type == "object"
  and (keys | sort) == ["projectId"]
  and .projectId == $project_id
' <<<"$project_document" >/dev/null; then
  fail_identity
fi

require_empty "Cloud Run service $prefix-transport" \
  gcloud run services list \
  --project="$project_id" \
  --region="$region" \
  --filter="metadata.name=$prefix-transport" \
  --format='value(metadata.name)'
for pool in relay agentrun; do
  require_empty "Cloud Run worker pool $prefix-$pool" \
    gcloud beta run worker-pools list \
    --project="$project_id" \
    --region="$region" \
    --filter="metadata.name=$prefix-$pool" \
    --format='value(metadata.name)'
done
for job in database-bootstrap migration reconciliation reference-seed; do
  require_empty "Cloud Run job $prefix-$job" \
    gcloud run jobs list \
    --project="$project_id" \
    --region="$region" \
    --filter="metadata.name=$prefix-$job" \
    --format='value(metadata.name)'
done
require_empty "serverless NEG $prefix-transport" \
  gcloud compute network-endpoint-groups list \
  --project="$project_id" \
  --regions="$region" \
  --filter="name=$prefix-transport" \
  --format='value(name)'
require_empty "edge backend $prefix-transport" \
  gcloud compute backend-services list \
  --project="$project_id" \
  --global \
  --filter="name=$prefix-transport" \
  --format='value(name)'
require_empty "managed certificate $prefix-edge" \
  gcloud compute ssl-certificates list \
  --project="$project_id" \
  --global \
  --filter="name=$prefix-edge" \
  --format='value(name)'
require_empty "edge resource $prefix-edge (addresses)" \
  gcloud compute addresses list \
  --project="$project_id" \
  --global \
  --filter="name=$prefix-edge" \
  --format='value(name)'
require_empty "edge resource $prefix-edge (security-policies)" \
  gcloud compute security-policies list \
  --project="$project_id" \
  --filter="name=$prefix-edge" \
  --format='value(name)'
require_empty "edge resource $prefix-edge (url-maps)" \
  gcloud compute url-maps list \
  --project="$project_id" \
  --global \
  --filter="name=$prefix-edge" \
  --format='value(name)'
require_empty "edge resource $prefix-edge (target-https-proxies)" \
  gcloud compute target-https-proxies list \
  --project="$project_id" \
  --global \
  --filter="name=$prefix-edge" \
  --format='value(name)'
require_empty "edge resource $prefix-edge (forwarding-rules)" \
  gcloud compute forwarding-rules list \
  --project="$project_id" \
  --global \
  --filter="name=$prefix-edge" \
  --format='value(name)'
require_empty "runtime monitoring dashboard" \
  gcloud monitoring dashboards list --project="$project_id" \
  --filter='displayName="Osfo development runtime, unqualified candidate"' \
  --format='value(name)'
require_empty "relay publisher binding" \
  gcloud pubsub topics get-iam-policy "$prefix-agentruns" \
  --project="$project_id" \
  --flatten='bindings[].members' \
  --filter="bindings.role=roles/pubsub.publisher AND bindings.members=serviceAccount:$prefix-relay@$project_id.iam.gserviceaccount.com" \
  --format='value(bindings.members)'
require_empty "AgentRun subscriber binding" \
  gcloud pubsub subscriptions get-iam-policy "$prefix-agentruns" \
  --project="$project_id" \
  --flatten='bindings[].members' \
  --filter="bindings.role=roles/pubsub.subscriber AND bindings.members=serviceAccount:$prefix-agentrun@$project_id.iam.gserviceaccount.com" \
  --format='value(bindings.members)'

if ((residue != 0)); then
  exit 1
fi
printf 'PASS: development runtime serving resources are absent\n'
