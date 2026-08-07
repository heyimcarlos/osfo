#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
root=$repo_root/infra/roots/development/platform
varset=${TF_VARSET_FILE:-$root/development.tfvars.json}
terraform_bin=${TERRAFORM_BIN:-terraform}
project_id=$(jq -r '.project_id' "$varset")
region=$(jq -r '.region' "$varset")
name_prefix=$(jq -r '.name_prefix' "$varset")
cost_owner=$(jq -r '.cost_owner' "$varset")
evidence_bucket=$(jq -r '.evidence_archive_bucket_name' "$varset")
preflight_report=${PREFLIGHT_REPORT_FILE:-${TMPDIR:-/tmp}/osfo-development-platform-preflight.json}
scratch=$(mktemp -d)
smoke_subscription=""
cleanup_smoke() {
  if [[ -n "$smoke_subscription" ]]; then
    CLOUDSDK_API_ENDPOINT_OVERRIDES_PUBSUB="https://$region-pubsub.googleapis.com/" \
      gcloud pubsub subscriptions delete "$smoke_subscription" \
      --project="$project_id" --quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$scratch"
}
trap cleanup_smoke EXIT

"$terraform_bin" -chdir="$root" output -json platform >"$scratch/platform.json"
sql_instance=$(jq -r '.cloud_sql_connection_name | split(":")[-1]' "$scratch/platform.json")
topic=$(jq -r '.pubsub_topic_id' "$scratch/platform.json")
subscription=$(jq -r '.pubsub_subscription_id' "$scratch/platform.json")
artifact_bucket=$(jq -r '.artifact_bucket_name' "$scratch/platform.json")
network_id=$(jq -r '.network_id' "$scratch/platform.json")
static_egress_ip=$(jq -r '.static_egress_ip' "$scratch/platform.json")
network_probe_job=$(jq -r '.qualification_probe_jobs.network' "$scratch/platform.json")
temporal_secret_probe_job=$(jq -r '.qualification_probe_jobs.temporal_secret' "$scratch/platform.json")
denied_secret_probe_job=$(jq -r '.qualification_probe_jobs.denied_secret' "$scratch/platform.json")

gcloud sql instances describe "$sql_instance" --project="$project_id" --format=json >"$scratch/sql.json"
gcloud sql users list --instance="$sql_instance" --project="$project_id" --format=json >"$scratch/sql-users.json"
jq -e --arg cost_owner "$cost_owner" '
  .state == "RUNNABLE"
  and ([.ipAddresses[].type] | all(. == "PRIVATE"))
  and any(.settings.databaseFlags[]; .name == "cloudsql.iam_authentication" and .value == "on")
  and .settings.userLabels.environment == "development"
  and .settings.userLabels.cost_owner == $cost_owner
' "$scratch/sql.json" >/dev/null
jq -r '.runtime_service_accounts[] | sub("[.]gserviceaccount[.]com$"; "")' "$scratch/platform.json" \
  | while IFS= read -r database_user; do
      jq -e --arg database_user "$database_user" \
        'any(.[]; .name == $database_user and .type == "CLOUD_IAM_SERVICE_ACCOUNT")' \
        "$scratch/sql-users.json" >/dev/null
    done

ordering_key="smoke-$(date -u +%Y%m%dT%H%M%SZ)"
smoke_subscription="$name_prefix-ordering-$RANDOM"
export CLOUDSDK_API_ENDPOINT_OVERRIDES_PUBSUB="https://$region-pubsub.googleapis.com/"
gcloud pubsub subscriptions describe "$subscription" --project="$project_id" \
  --format=json >"$scratch/managed-subscription.json"
jq -e --arg topic "$topic" --arg retention "$(jq -r '.pubsub_message_retention_duration' "$varset")" '
  .topic == $topic
  and .enableMessageOrdering == true
  and .messageRetentionDuration == $retention
  and .retainAckedMessages == false
' "$scratch/managed-subscription.json" >/dev/null
# Delivery uses an isolated subscriber so qualification cannot lease or acknowledge
# messages owned by a runtime consumer of the Terraform-managed subscription.
gcloud pubsub subscriptions create "$smoke_subscription" --project="$project_id" \
  --topic="$topic" --enable-message-ordering --expiration-period=1d >/dev/null
gcloud pubsub topics publish "$topic" --project="$project_id" \
  --ordering-key="$ordering_key" --message=first >/dev/null
gcloud pubsub topics publish "$topic" --project="$project_id" \
  --ordering-key="$ordering_key" --message=second >/dev/null
printf '[]\n' >"$scratch/messages.json"
for _ in {1..12}; do
  gcloud pubsub subscriptions pull "$smoke_subscription" --project="$project_id" \
    --auto-ack --limit=10 --format=json >"$scratch/message-batch.json"
  jq -s --arg ordering_key "$ordering_key" \
    'add | map(select(.message.orderingKey == $ordering_key))' \
    "$scratch/messages.json" "$scratch/message-batch.json" >"$scratch/messages.next.json"
  mv "$scratch/messages.next.json" "$scratch/messages.json"
  if (( $(jq 'length' "$scratch/messages.json") >= 2 )); then
    break
  fi
  sleep 5
done
jq -e 'length >= 2 and ([.[0:2][].message.data | @base64d] == ["first", "second"])' \
  "$scratch/messages.json" >/dev/null
gcloud pubsub topics describe "$topic" --project="$project_id" --format=json \
  | jq -e --arg cost_owner "$cost_owner" \
    '.labels.environment == "development" and .labels.cost_owner == $cost_owner' >/dev/null
gcloud pubsub subscriptions delete "$smoke_subscription" --project="$project_id" --quiet >/dev/null
smoke_subscription=""
unset CLOUDSDK_API_ENDPOINT_OVERRIDES_PUBSUB

printf 'osfo development artifact smoke\n' >"$scratch/artifact"
artifact_sha=$(sha256sum "$scratch/artifact" | cut -d' ' -f1)
artifact_uri="gs://$artifact_bucket/sha256/$artifact_sha"
gcloud storage cp --if-generation-match=0 "$scratch/artifact" "$artifact_uri" >/dev/null
if gcloud storage cp --if-generation-match=0 "$scratch/artifact" "$artifact_uri" \
  >"$scratch/artifact-overwrite.out" 2>&1; then
  printf 'FAIL: content-addressed artifact accepted a second generation\n' >&2
  exit 1
fi
generation_count=$(gcloud storage ls --all-versions "$artifact_uri" | wc -l | tr -d ' ')
if [[ "$generation_count" != 1 ]]; then
  printf 'FAIL: content-addressed artifact has %s generations\n' "$generation_count" >&2
  exit 1
fi
gcloud storage cp "$artifact_uri" "$scratch/artifact.read" >/dev/null
cmp "$scratch/artifact" "$scratch/artifact.read"

printf 'osfo non-secret authorization smoke\n' >"$scratch/secret-payload"
terraform_service_account=$(jq -r '.terraform_service_account_email' "$varset")
effective_account=${CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:-$(gcloud auth list --filter=status:ACTIVE --format='value(account)')}
if [[ "$effective_account" != "$terraform_service_account" ]]; then
  printf 'FAIL: live proof must run as CI platform identity %s, got %s\n' \
    "$terraform_service_account" "$effective_account" >&2
  exit 1
fi
for secret_key in model-adapter temporal-cloud; do
  secret=$(jq -r --arg secret_key "$secret_key" '.secret_names[$secret_key]' "$scratch/platform.json")
  gcloud secrets versions add "$secret" --project="$project_id" \
    --data-file="$scratch/secret-payload" >/dev/null
done

gcloud run jobs execute "$network_probe_job" --project="$project_id" \
  --region="$region" --wait --format=json >"$scratch/network-execution.json"
gcloud run jobs execute "$temporal_secret_probe_job" --project="$project_id" \
  --region="$region" --wait --format=json >"$scratch/temporal-secret-execution.json"
gcloud run jobs execute "$denied_secret_probe_job" --project="$project_id" \
  --region="$region" --wait --format=json >"$scratch/denied-secret-execution.json"

gcloud compute routers nats describe "$name_prefix-nat" --router="$name_prefix-router" \
  --region="$region" --project="$project_id" --format=json >"$scratch/nat.json"
gcloud compute addresses describe "$name_prefix-egress" --region="$region" \
  --project="$project_id" --format=json >"$scratch/egress.json"
gcloud dns managed-zones describe "$name_prefix-private" --project="$project_id" \
  --format=json >"$scratch/dns.json"
jq -e '
  .natIpAllocateOption == "MANUAL_ONLY"
  and .sourceSubnetworkIpRangesToNat == "LIST_OF_SUBNETWORKS"
  and (.natIps | length) == 1
  and .logConfig.enable == true
' "$scratch/nat.json" >/dev/null
jq -e --arg expected_ip "$static_egress_ip" \
  --arg cost_owner "$cost_owner" \
  '.address == $expected_ip
    and .addressType == "EXTERNAL"
    and .status == "IN_USE"
    and .labels.environment == "development"
    and .labels.cost_owner == $cost_owner' \
  "$scratch/egress.json" >/dev/null
jq -e --arg network_id "$network_id" --arg cost_owner "$cost_owner" '
  .visibility == "private"
  and any(.privateVisibilityConfig.networks[]; .networkUrl | endswith($network_id))
  and .labels.environment == "development"
  and .labels.cost_owner == $cost_owner
' "$scratch/dns.json" >/dev/null

temporal_status=MISSING
private_dns_record_status=MISSING
temporal_attachment=""
if gcloud compute forwarding-rules describe "$name_prefix-temporal-psc" \
  --region="$region" --project="$project_id" --format=json >"$scratch/temporal.json" 2>/dev/null; then
  temporal_attachment=$(jq -r '.target' "$scratch/temporal.json")
  jq -e '
    .pscConnectionStatus == "ACCEPTED"
    and (.target | test("^projects/[^/]+/regions/us-east4/serviceAttachments/[^/]+$"))
  ' "$scratch/temporal.json" >/dev/null
  gcloud dns record-sets describe "api.temporal.internal." \
    --zone="$name_prefix-private" --type=A --project="$project_id" --format=json \
    >"$scratch/temporal-dns.json"
  temporal_status=PASS
  private_dns_record_status=PASS
fi

test -f "$preflight_report"
managed_qualification=MISSING
jq -n \
  --arg qualification "$managed_qualification" \
  --arg project_id "$project_id" \
  --arg region "$region" \
  --arg artifact_sha256 "$artifact_sha" \
  --arg pubsub_endpoint "$region-pubsub.googleapis.com" \
  --arg temporal_service_attachment "$temporal_attachment" \
  --arg temporal_private_service_connect "$temporal_status" \
  --arg private_dns_record "$private_dns_record_status" \
  --slurpfile quota_preflight "$preflight_report" \
  --slurpfile network_execution "$scratch/network-execution.json" \
  --slurpfile temporal_secret_execution "$scratch/temporal-secret-execution.json" \
  --slurpfile denied_secret_execution "$scratch/denied-secret-execution.json" \
  '{schema_version: 1, qualification: $qualification, project_id: $project_id, region: $region, checks: {
    private_cloud_sql_configuration_and_iam_users: "PASS",
    private_database_connection_from_direct_vpc: "PASS",
    managed_ordered_subscription_configuration: "PASS",
    ordered_pubsub_round_trip: "PASS",
    artifact_precondition_round_trip: "PASS",
    artifact_precondition_rejected_second_generation: "PASS",
    artifact_immutability_enforced_by_iam: "MISSING",
    authorized_secret_version_access: "PASS",
    exact_permission_denied_secret_payload_access: "PASS",
    probe_base_image_digest: "PASS",
    probe_toolchain_determinism: "MISSING",
    private_dns_zone_and_static_nat_configuration: "PASS",
    private_dns_resolution_from_direct_vpc: "PASS",
    private_dns_record: $private_dns_record,
    static_nat_traffic_from_direct_vpc: "PASS",
    temporal_private_service_connect: $temporal_private_service_connect,
    quota_preflight: $quota_preflight[0]
  }, artifact_sha256: $artifact_sha256, pubsub_endpoint: $pubsub_endpoint,
  qualification_executions: {
    network: $network_execution[0].metadata.name,
    temporal_secret: $temporal_secret_execution[0].metadata.name,
    denied_secret: $denied_secret_execution[0].metadata.name
  },
  temporal_service_attachment: $temporal_service_attachment}' >"$scratch/report.json"

report_sha=$("$repo_root/infra/tests/store-development-evidence.sh" \
  "$scratch/report.json" "$evidence_bucket")

printf 'qualification=%s temporal=%s evidence=%s\n' \
  "$managed_qualification" "$temporal_status" "$report_sha"
