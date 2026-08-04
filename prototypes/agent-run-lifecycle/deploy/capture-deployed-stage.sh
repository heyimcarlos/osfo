#!/usr/bin/env bash
set -euo pipefail

project="${GOOGLE_CLOUD_PROJECT:?GOOGLE_CLOUD_PROJECT is required}"
region="${OSFO_DEPLOY_REGION:-northamerica-northeast2}"
start="${OSFO_STAGE_START:?OSFO_STAGE_START is required in RFC 3339 UTC}"
end="${OSFO_STAGE_END:?OSFO_STAGE_END is required in RFC 3339 UTC}"
output="${OSFO_EVIDENCE_DIR:?OSFO_EVIDENCE_DIR is required}"
ingress_service="${OSFO_INGRESS_SERVICE:-osfo-ingress}"
stream_service="${OSFO_STREAM_SERVICE:-osfo-stream}"
agent_worker="${OSFO_AGENT_RUN_WORKER_POOL:-osfo-agent-run-worker}"
temporal_worker="${OSFO_TEMPORAL_WORKER_POOL:-osfo-temporal-cloud-worker}"
sql_instance="${OSFO_CLOUD_SQL_INSTANCE:?OSFO_CLOUD_SQL_INSTANCE is required}"

mkdir -p "$output/cloud-monitoring" "$output/topology"
access_token="$(gcloud auth print-access-token)"

sanitize_public_json() {
  jq 'walk(
    if type == "object" then
      del(."serving.knative.dev/creator", ."serving.knative.dev/lastModifier")
    elif type == "string" and test("[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}"; "i") then
      "<redacted-principal>"
    else
      .
    end
  )'
}

query_metric() {
  local name="$1"
  local metric="$2"
  local resource_filter="$3"
  printf 'header = "Authorization: Bearer %s"\n' "$access_token" | \
    curl --config - --fail --silent --show-error --connect-timeout 5 --max-time 30 \
    --retry 8 --retry-all-errors --retry-delay 2 --get \
    "https://monitoring.googleapis.com/v3/projects/$project/timeSeries" \
    --data-urlencode "filter=metric.type = \"$metric\" AND $resource_filter" \
    --data-urlencode "interval.startTime=$start" \
    --data-urlencode "interval.endTime=$end" \
    --data-urlencode 'view=FULL' \
    --data-urlencode 'pageSize=100000' | \
    sanitize_public_json >"$output/cloud-monitoring/$name.json"
}

query_insight_metric() {
  local name="$1"
  local metric="$2"
  local insight_filter="resource.type = \"cloudsql_instance_database\" AND resource.labels.resource_id = \"$project:$sql_instance\" AND resource.labels.database = \"osfo_v1\""
  printf 'header = "Authorization: Bearer %s"\n' "$access_token" | \
    curl --config - --fail --silent --show-error --connect-timeout 5 --max-time 30 \
    --retry 8 --retry-all-errors --retry-delay 2 --get \
    "https://monitoring.googleapis.com/v3/projects/$project/timeSeries" \
    --data-urlencode "filter=metric.type = \"$metric\" AND $insight_filter" \
    --data-urlencode "interval.startTime=$start" \
    --data-urlencode "interval.endTime=$end" \
    --data-urlencode 'view=FULL' \
    --data-urlencode 'pageSize=100000' | \
    sanitize_public_json >"$output/cloud-monitoring/$name.json"
}

ingress_filter="resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"$ingress_service\""
stream_filter="resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"$stream_service\""
agent_worker_filter="resource.type = \"cloud_run_worker_pool\" AND resource.labels.worker_pool_name = \"$agent_worker\""
temporal_worker_filter="resource.type = \"cloud_run_worker_pool\" AND resource.labels.worker_pool_name = \"$temporal_worker\""
sql_filter="resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"$project:$sql_instance\""

query_metric ingress-request-count run.googleapis.com/request_count "$ingress_filter"
query_metric ingress-request-latencies run.googleapis.com/request_latencies "$ingress_filter"
query_metric ingress-e2e-latencies run.googleapis.com/request_latency/e2e_latencies "$ingress_filter"
query_metric ingress-instance-count run.googleapis.com/container/instance_count "$ingress_filter"
query_metric ingress-cpu run.googleapis.com/container/cpu/utilizations "$ingress_filter"
query_metric ingress-memory run.googleapis.com/container/memory/utilizations "$ingress_filter"
query_metric ingress-startup-latencies run.googleapis.com/container/startup_latencies "$ingress_filter"

query_metric stream-request-count run.googleapis.com/request_count "$stream_filter"
query_metric stream-request-latencies run.googleapis.com/request_latencies "$stream_filter"
query_metric stream-instance-count run.googleapis.com/container/instance_count "$stream_filter"
query_metric stream-cpu run.googleapis.com/container/cpu/utilizations "$stream_filter"
query_metric stream-memory run.googleapis.com/container/memory/utilizations "$stream_filter"

for fleet in agent temporal; do
  if [[ "$fleet" == agent ]]; then
    filter="$agent_worker_filter"
  else
    filter="$temporal_worker_filter"
  fi
  query_metric "$fleet-worker-instance-count" run.googleapis.com/container/instance_count "$filter"
  query_metric "$fleet-worker-cpu" run.googleapis.com/container/cpu/utilizations "$filter"
  query_metric "$fleet-worker-memory" run.googleapis.com/container/memory/utilizations "$filter"
  query_metric "$fleet-worker-received-bytes" run.googleapis.com/container/network/received_bytes_count "$filter"
  query_metric "$fleet-worker-sent-bytes" run.googleapis.com/container/network/sent_bytes_count "$filter"
done

query_metric cloudsql-cpu cloudsql.googleapis.com/database/cpu/utilization "$sql_filter"
query_metric cloudsql-memory cloudsql.googleapis.com/database/memory/utilization "$sql_filter"
query_metric cloudsql-connections cloudsql.googleapis.com/database/network/connections "$sql_filter"
query_metric cloudsql-backends cloudsql.googleapis.com/database/postgresql/num_backends "$sql_filter"
query_metric cloudsql-backends-in-wait cloudsql.googleapis.com/database/postgresql/backends_in_wait "$sql_filter"
query_metric cloudsql-transactions cloudsql.googleapis.com/database/postgresql/transaction_count "$sql_filter"
query_metric cloudsql-wal-bytes cloudsql.googleapis.com/database/postgresql/write_ahead_log/written_bytes_count "$sql_filter"
query_metric cloudsql-read-ops cloudsql.googleapis.com/database/disk/read_ops_count "$sql_filter"
query_metric cloudsql-write-ops cloudsql.googleapis.com/database/disk/write_ops_count "$sql_filter"

query_insight_metric cloudsql-query-execution-time cloudsql.googleapis.com/database/postgresql/insights/perquery/execution_time
query_insight_metric cloudsql-query-latencies cloudsql.googleapis.com/database/postgresql/insights/perquery/latencies
query_insight_metric cloudsql-query-lock-time cloudsql.googleapis.com/database/postgresql/insights/perquery/lock_time
query_insight_metric cloudsql-query-block-access cloudsql.googleapis.com/database/postgresql/insights/perquery/shared_blk_access_count
query_insight_metric cloudsql-aggregate-execution-time cloudsql.googleapis.com/database/postgresql/insights/aggregate/execution_time
query_insight_metric cloudsql-aggregate-latencies cloudsql.googleapis.com/database/postgresql/insights/aggregate/latencies

gcloud run services describe "$ingress_service" \
  --project "$project" --region "$region" --format json | sanitize_public_json \
  >"$output/topology/ingress-service.json"
gcloud run services describe "$stream_service" \
  --project "$project" --region "$region" --format json | sanitize_public_json \
  >"$output/topology/stream-service.json"
gcloud beta run worker-pools describe "$agent_worker" \
  --project "$project" --region "$region" --format json | sanitize_public_json \
  >"$output/topology/agent-run-worker.json"
gcloud beta run worker-pools describe "$temporal_worker" \
  --project "$project" --region "$region" --format json | sanitize_public_json \
  >"$output/topology/temporal-cloud-worker.json"
gcloud sql instances describe "$sql_instance" \
  --project "$project" --format json | sanitize_public_json \
  >"$output/topology/cloud-sql.json"

jq -n \
  --arg project "$project" \
  --arg region "$region" \
  --arg start "$start" \
  --arg end "$end" \
  --arg ingress "$ingress_service" \
  --arg stream "$stream_service" \
  --arg agent_worker "$agent_worker" \
  --arg temporal_worker "$temporal_worker" \
  --arg sql "$sql_instance" \
  '{schema_version:1,project:$project,region:$region,start:$start,end:$end,ingress_service:$ingress,stream_service:$stream,agent_run_worker_pool:$agent_worker,temporal_worker_pool:$temporal_worker,cloud_sql_instance:$sql}' \
  >"$output/stage-manifest.json"

(
  cd "$output"
  checksum_temp="$(mktemp .SHA256SUMS.XXXXXX)"
  find . -type f ! -name 'SHA256SUMS*' ! -name '.SHA256SUMS*' -print0 | sort -z | xargs -0 sha256sum >"$checksum_temp"
  mv "$checksum_temp" SHA256SUMS
)
