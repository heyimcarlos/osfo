#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_dir="${1:?usage: run-presentation.sh OUTPUT_DIR RETAINED_ROOT FAILED_ROOT PILOT_ROOT}"
retained_root="${2:?missing retained Montreal evidence root}"
failed_root="${3:?missing us-east4 current-WAL failure root}"
pilot_root="${4:?missing 4096-reserve pilot root}"
prometheus_port="${OSFO_OPENPOKE_PROMETHEUS_PORT:-19090}"
grafana_port="${OSFO_OPENPOKE_GRAFANA_PORT:-13000}"
prometheus_url="http://127.0.0.1:${prometheus_port}"
grafana_url="http://127.0.0.1:${grafana_port}"

if [[ -e "$output_dir" ]]; then
  echo "refusing to overwrite presentation bundle: $output_dir" >&2
  exit 1
fi

for evidence_root in "$retained_root" "$failed_root" "$pilot_root"; do
  if [[ ! -d "$evidence_root" ]]; then
    echo "evidence root is not a directory: $evidence_root" >&2
    exit 1
  fi
done

mkdir -p \
  "$output_dir/config" \
  "$output_dir/grafana/api" \
  "$output_dir/prometheus/queries" \
  "$output_dir/screenshots"

printf '%q ' "$0" "$@" > "$output_dir/capture-command.txt"
printf '\n' >> "$output_dir/capture-command.txt"

jq -n \
  --arg retained "$retained_root" \
  --arg failed "$failed_root" \
  --arg pilot "$pilot_root" \
  '{bundles:[
    {
      root:$retained,
      run:"montreal-sustained-232",
      classification:"retained",
      qualifying:true,
      region:"northamerica-northeast1",
      history:"accumulated",
      wal:"current"
    },
    {
      root:$failed,
      run:"us-east4-current-wal",
      classification:"failed",
      qualifying:false
    },
    {
      root:$pilot,
      run:"reserve-4096-pilot",
      classification:"pilot",
      qualifying:false,
      region:"northamerica-northeast1",
      history:"clean",
      wal:"current"
    }
  ]}' > "$output_dir/config/presentation-runs.json"

bun "$prototype_dir/evidence-importer.ts" \
  --manifest "$output_dir/config/presentation-runs.json" \
  --output "$output_dir/openpoke.prom" \
  --openmetrics "$output_dir/openpoke.openmetrics" \
  --report "$output_dir/import-report.json"
cp "$output_dir/openpoke.prom" "$prototype_dir/generated/openpoke.prom"
cp "$output_dir/openpoke.openmetrics" "$prototype_dir/generated/openpoke.openmetrics"

docker compose --file "$prototype_dir/compose.yaml" down --volumes --remove-orphans
docker compose --file "$prototype_dir/compose.yaml" run --rm --no-deps \
  --entrypoint /bin/promtool \
  prometheus \
  tsdb create-blocks-from openmetrics /evidence/openpoke.openmetrics /prometheus
docker compose --file "$prototype_dir/compose.yaml" up --detach --wait

curl --fail --silent --show-error "$prometheus_url/-/ready" > "$output_dir/prometheus/ready.txt"
curl --fail --silent --show-error "$grafana_url/api/health" > "$output_dir/grafana/health.json"

for _ in {1..30}; do
  curl --fail --silent --show-error "$prometheus_url/api/v1/targets" \
    > "$output_dir/prometheus/targets.json"
  if jq -e \
    '.data.activeTargets | length > 0 and all(.[]; .health == "up")' \
    "$output_dir/prometheus/targets.json" \
    > /dev/null; then
    break
  fi
  sleep 1
done
jq -e \
  '.data.activeTargets | length > 0 and all(.[]; .health == "up")' \
  "$output_dir/prometheus/targets.json" \
  > /dev/null

from_utc="$(jq -er '.utcRange.from' "$output_dir/import-report.json")"
to_utc="$(jq -er '.utcRange.to' "$output_dir/import-report.json")"
from_seconds="$(date --utc --date="$from_utc" +%s)"
to_seconds="$(date --utc --date="$to_utc" +%s)"
from_milliseconds="$((from_seconds * 1000))"
to_milliseconds="$((to_seconds * 1000))"
jq -n \
  --arg from "$from_utc" \
  --arg to "$to_utc" \
  --argjson from_ms "$from_milliseconds" \
  --argjson to_ms "$to_milliseconds" \
  '{timezone:"UTC",from:$from,to:$to,from_milliseconds:$from_ms,to_milliseconds:$to_ms}' \
  > "$output_dir/config/locked-time-range.json"

cp "$prototype_dir/compose.yaml" "$output_dir/config/compose.yaml"
cp "$prototype_dir/prometheus.yml" "$output_dir/config/prometheus.yml"
cp "$prototype_dir/presentation-queries.tsv" "$output_dir/config/presentation-queries.tsv"
cp "$prototype_dir/evidence-importer.ts" "$output_dir/config/evidence-importer.ts"
cp -R "$prototype_dir/grafana" "$output_dir/config/grafana"

while IFS=$'\t' read -r query_name query; do
  curl --fail --silent --show-error --get \
    --data-urlencode "query=$query" \
    --data-urlencode "time=$to_seconds" \
    "$prometheus_url/api/v1/query" \
    > "$output_dir/prometheus/queries/$query_name.json"
done < "$prototype_dir/presentation-queries.tsv"

curl --fail --silent --show-error "$prometheus_url/api/v1/status/config" \
  > "$output_dir/prometheus/runtime-config.json"
curl --fail --silent --show-error "$prometheus_url/api/v1/status/buildinfo" \
  > "$output_dir/prometheus/build-info.json"

dashboard_uids=(
  openpoke-100k-scorecard
  openpoke-capacity-postgres
  openpoke-durability-recovery
  openpoke-multi-device
  openpoke-topology-evolution
)
for dashboard_uid in "${dashboard_uids[@]}"; do
  curl --fail --silent --show-error "$grafana_url/api/dashboards/uid/$dashboard_uid" \
    > "$output_dir/grafana/api/$dashboard_uid.json"
done

browser_profile="$(mktemp -d)"
for dashboard_uid in "${dashboard_uids[@]}"; do
  dashboard_url="${grafana_url}/d/${dashboard_uid}?orgId=1&from=${from_milliseconds}&to=${to_milliseconds}&timezone=utc&var-run=us-east4-current-wal&kiosk&theme=light"
  chromium \
    --headless=new \
    --no-sandbox \
    --disable-gpu \
    --hide-scrollbars \
    --user-data-dir="$browser_profile" \
    --virtual-time-budget=8000 \
    --window-size=1920,1080 \
    --screenshot="$output_dir/screenshots/$dashboard_uid.png" \
    "$dashboard_url" \
    > "$output_dir/screenshots/$dashboard_uid.browser.log" 2>&1
done
rm -rf "$browser_profile"

(
  cd "$output_dir"
  find . -type f ! -name SEALED-SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    > SEALED-SHA256SUMS
)

echo "OpenPoke presentation bundle sealed: $output_dir"
echo "Grafana: $grafana_url/d/openpoke-100k-scorecard?var-run=us-east4-current-wal"
