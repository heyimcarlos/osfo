#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
evidence_dir="${1:?usage: capture-evidence.sh EVIDENCE_DIR START_UNIX_SECONDS END_UNIX_SECONDS}"
start_seconds="${2:?missing start time}"
end_seconds="${3:?missing end time}"
prometheus_url="${OSFO_PROMETHEUS_URL:-http://127.0.0.1:9090}"
grafana_url="${OSFO_GRAFANA_URL:-http://127.0.0.1:3000}"

mkdir -p "$evidence_dir/prometheus/queries" "$evidence_dir/grafana" "$evidence_dir/config"
cp "$prototype_dir/observability/acceptance-queries.tsv" "$evidence_dir/config/acceptance-queries.tsv"
cp "$prototype_dir/observability/prometheus.yml" "$evidence_dir/config/prometheus.yml"
cp "$prototype_dir/observability/grafana/dashboards/agent-run-lifecycle.json" "$evidence_dir/config/grafana-dashboard.json"
cp "$prototype_dir/observability/grafana/provisioning/datasources/prometheus.yml" "$evidence_dir/config/grafana-datasource.yml"
cp "$prototype_dir/observability/grafana/provisioning/dashboards/dashboards.yml" "$evidence_dir/config/grafana-provisioning.yml"

while IFS=$'\t' read -r query_name query; do
  curl --fail --silent --show-error --get \
    --data-urlencode "query=$query" \
    --data-urlencode "start=$start_seconds" \
    --data-urlencode "end=$end_seconds" \
    --data-urlencode "step=1s" \
    "$prometheus_url/api/v1/query_range" \
    > "$evidence_dir/prometheus/queries/$query_name.json"
done < "$prototype_dir/observability/acceptance-queries.tsv"

curl --fail --silent --show-error "$prometheus_url/api/v1/targets" \
  > "$evidence_dir/prometheus/targets.json"
curl --fail --silent --show-error "$prometheus_url/api/v1/status/config" \
  > "$evidence_dir/prometheus/runtime-config.json"
snapshot_name="$(curl --fail --silent --show-error --request POST \
  "$prometheus_url/api/v1/admin/tsdb/snapshot" | jq -er '.data.name')"
docker compose --file "$prototype_dir/compose.yaml" cp \
  "prometheus:/prometheus/snapshots/$snapshot_name" \
  "$evidence_dir/prometheus/tsdb-snapshot"

curl --fail --silent --show-error \
  "$grafana_url/api/dashboards/uid/osfo-agent-run-lifecycle" \
  > "$evidence_dir/grafana/dashboard-api.json"
curl --fail --silent --show-error --get \
  --data-urlencode "from=$((start_seconds * 1000))" \
  --data-urlencode "to=$((end_seconds * 1000))" \
  "$grafana_url/api/annotations" \
  > "$evidence_dir/grafana/annotations.json"

(
  cd "$evidence_dir"
  find . -type f ! -name checksums.sha256 -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    > checksums.sha256
)
