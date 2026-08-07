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
trap 'rm -rf "$scratch"' EXIT

"$terraform_bin" -chdir="$root" output -json platform >"$scratch/platform.json"
sql_instance=$(jq -r '.cloud_sql_connection_name | split(":")[-1]' "$scratch/platform.json")
topic=$(jq -r '.pubsub_topic_id' "$scratch/platform.json")
subscription=$(jq -r '.pubsub_subscription_id' "$scratch/platform.json")
artifact_bucket=$(jq -r '.artifact_bucket_name' "$scratch/platform.json")
network_id=$(jq -r '.network_id' "$scratch/platform.json")
static_egress_ip=$(jq -r '.static_egress_ip' "$scratch/platform.json")

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
gcloud pubsub topics publish "$topic" --project="$project_id" --ordering-key="$ordering_key" --message=first >/dev/null
gcloud pubsub topics publish "$topic" --project="$project_id" --ordering-key="$ordering_key" --message=second >/dev/null
printf '[]\n' >"$scratch/messages.json"
for _ in {1..12}; do
  gcloud pubsub subscriptions pull "$subscription" --project="$project_id" \
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

printf 'osfo development artifact smoke\n' >"$scratch/artifact"
artifact_sha=$(sha256sum "$scratch/artifact" | cut -d' ' -f1)
artifact_uri="gs://$artifact_bucket/sha256/$artifact_sha"
gcloud storage cp --if-generation-match=0 "$scratch/artifact" "$artifact_uri" >/dev/null
gcloud storage cp "$artifact_uri" "$scratch/artifact.read" >/dev/null
cmp "$scratch/artifact" "$scratch/artifact.read"

printf 'osfo non-secret authorization smoke\n' >"$scratch/secret-payload"
active_account=$(gcloud auth list --filter=status:ACTIVE --format='value(account)')
terraform_service_account=$(jq -r '.terraform_service_account_email' "$varset")
secret_version_access_status=MISSING
for secret_key in model-adapter temporal-cloud; do
  secret=$(jq -r --arg secret_key "$secret_key" '.secret_names[$secret_key]' "$scratch/platform.json")
  case "$secret_key" in
    model-adapter) accessor_key=agentrun ;;
    temporal-cloud) accessor_key=temporal ;;
  esac
  accessor=$(jq -r --arg accessor_key "$accessor_key" '.runtime_service_accounts[$accessor_key]' "$scratch/platform.json")
  member="serviceAccount:$accessor"
  gcloud secrets get-iam-policy "$secret" --project="$project_id" --format=json \
    | jq -e --arg member "$member" '
      any(.bindings[]; .role == "roles/secretmanager.secretAccessor" and any(.members[]; . == $member))
    ' >/dev/null
  if [[ "$active_account" == "$terraform_service_account" ]]; then
    gcloud secrets versions add "$secret" --project="$project_id" \
      --data-file="$scratch/secret-payload" >/dev/null
    for _ in {1..12}; do
      if gcloud secrets versions access latest --secret="$secret" --project="$project_id" \
        --impersonate-service-account="$accessor" >"$scratch/$secret_key.read" 2>/dev/null; then
        break
      fi
      sleep 5
    done
    cmp "$scratch/secret-payload" "$scratch/$secret_key.read"
    secret_version_access_status=PASS
  fi
done

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

temporal_attachment=$(jq -r '.temporal_service_attachment_uri // empty' "$varset")
temporal_status=MISSING
private_dns_record_status=MISSING
if [[ -n "$temporal_attachment" ]]; then
  gcloud compute forwarding-rules describe "$name_prefix-temporal-psc" \
    --region="$region" --project="$project_id" --format=json >"$scratch/temporal.json"
  jq -e '.pscConnectionStatus == "ACCEPTED"' "$scratch/temporal.json" >/dev/null
  gcloud dns record-sets describe "api.$(jq -r '.temporal_dns_name' "$varset")" \
    --zone="$name_prefix-private" --type=A --project="$project_id" --format=json \
    >"$scratch/temporal-dns.json"
  temporal_status=PASS
  private_dns_record_status=PASS
fi

test -f "$preflight_report"
jq -n \
  --arg project_id "$project_id" \
  --arg region "$region" \
  --arg artifact_sha256 "$artifact_sha" \
  --arg temporal_private_service_connect "$temporal_status" \
  --arg private_dns_record "$private_dns_record_status" \
  --arg authorized_secret_version_access "$secret_version_access_status" \
  --slurpfile quota_preflight "$preflight_report" \
  '{schema_version: 1, qualification: "MISSING", project_id: $project_id, region: $region, checks: {
    private_cloud_sql_configuration_and_iam_users: "PASS",
    private_database_connection_from_direct_vpc: "MISSING",
    ordered_pubsub_round_trip: "PASS",
    immutable_artifact_round_trip: "PASS",
    intended_secret_accessor_policy: "PASS",
    authorized_secret_version_access: $authorized_secret_version_access,
    private_dns_zone_and_static_nat_configuration: "PASS",
    private_dns_record: $private_dns_record,
    static_nat_traffic_from_direct_vpc: "MISSING",
    temporal_private_service_connect: $temporal_private_service_connect,
    quota_preflight: $quota_preflight[0]
  }, artifact_sha256: $artifact_sha256}' >"$scratch/report.json"

report_sha=$("$repo_root/infra/tests/store-development-evidence.sh" \
  "$scratch/report.json" "$evidence_bucket")

printf 'MISSING: runtime network probes and Temporal PSC, managed checks retained as evidence=%s\n' "$report_sha"
