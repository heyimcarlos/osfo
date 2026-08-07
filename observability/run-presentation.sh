#!/usr/bin/env bash
set -euo pipefail

observability_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
final_output_dir="${1:?usage: run-presentation.sh OUTPUT_DIR RETAINED_ROOT FAILED_ROOT PILOT_ROOT}"
retained_root="${2:?missing retained Montreal evidence root}"
failed_root="${3:?missing us-east4 current-WAL failure root}"
pilot_root="${4:?missing 4096-reserve pilot root}"
prometheus_port="${OSFO_OPENPOKE_PROMETHEUS_PORT:-19090}"
grafana_port="${OSFO_OPENPOKE_GRAFANA_PORT:-13000}"
prometheus_url="http://127.0.0.1:${prometheus_port}"
grafana_url="http://127.0.0.1:${grafana_port}"
compose_project="osfo-openpoke-evidence"

final_output_dir="$(realpath --canonicalize-missing -- "$final_output_dir")"
if [[ -e "$final_output_dir" || -L "$final_output_dir" ]]; then
  echo "refusing to overwrite presentation bundle: $final_output_dir" >&2
  exit 1
fi

retained_root="$(realpath -- "$retained_root")"
failed_root="$(realpath -- "$failed_root")"
pilot_root="$(realpath -- "$pilot_root")"
for evidence_root in "$retained_root" "$failed_root" "$pilot_root"; do
  if [[ ! -d "$evidence_root" ]]; then
    echo "evidence root is not a directory: $evidence_root" >&2
    exit 1
  fi
  if [[ "$final_output_dir" == "$evidence_root" || "$final_output_dir" == "$evidence_root/"* ]]; then
    echo "presentation output must be outside every evidence root" >&2
    exit 1
  fi
done

output_parent="$(dirname "$final_output_dir")"
output_name="$(basename "$final_output_dir")"
mkdir -p -- "$output_parent"
staging_dir="$(mktemp -d --tmpdir="$output_parent" ".$output_name.staging.XXXXXX")"
chmod 0755 -- "$staging_dir"
output_dir="$staging_dir"
manifest_path="$staging_dir/import-manifest.json"
browser_profile="$staging_dir/.browser-profile"
compose_started=false
published=false

compose() {
  OSFO_OPENPOKE_EVIDENCE_DIR="$output_dir" \
    docker compose \
      --project-name "$compose_project" \
      --file "$observability_dir/compose.yaml" \
      "$@"
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  if [[ -n "$browser_profile" && -d "$browser_profile" ]]; then
    rm -rf -- "$browser_profile"
  fi
  if [[ -n "$manifest_path" && -f "$manifest_path" ]]; then
    rm -f -- "$manifest_path"
  fi
  if [[ $exit_status -ne 0 && "$compose_started" == true ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  if [[ $exit_status -ne 0 && "$published" == false && -d "$staging_dir" ]]; then
    rm -rf -- "$staging_dir"
  fi
  exit "$exit_status"
}
trap cleanup EXIT

sealed_benchmark_id() {
  local evidence_root=$1
  local checksum_name=""
  if [[ -f "$evidence_root/SHA256SUMS" && ! -L "$evidence_root/SHA256SUMS" ]]; then
    checksum_name="SHA256SUMS"
  elif [[ -f "$evidence_root/SEALED-SHA256SUMS" && ! -L "$evidence_root/SEALED-SHA256SUMS" ]]; then
    checksum_name="SEALED-SHA256SUMS"
  else
    echo "no regular checksum manifest in evidence root: $evidence_root" >&2
    return 1
  fi
  (
    cd "$evidence_root"
    sha256sum --check "$checksum_name" >/dev/null
    jq -er '.benchmark_id | select(type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]*$"))' \
      scenario.json
  )
}

retained_run="$(sealed_benchmark_id "$retained_root")"
failed_run="$(sealed_benchmark_id "$failed_root")"
pilot_run="$(sealed_benchmark_id "$pilot_root")"

mkdir -p \
  "$output_dir/config" \
  "$output_dir/dom" \
  "$output_dir/diagnostics" \
  "$output_dir/grafana/api" \
  "$output_dir/prometheus/queries" \
  "$output_dir/screenshots"

jq -n \
  --arg retained "$retained_root" \
  --arg failed "$failed_root" \
  --arg pilot "$pilot_root" \
  --arg retained_run "$retained_run" \
  --arg failed_run "$failed_run" \
  --arg pilot_run "$pilot_run" \
  '{
    selectedRegion:"us-east4",
    qualifyingRuns:[$failed_run],
    bundles:[
      {root:$retained,run:$retained_run,classification:"retained"},
      {root:$failed,run:$failed_run,classification:"failed"},
      {root:$pilot,run:$pilot_run,classification:"pilot"}
    ]
  }' > "$manifest_path"

bun "$observability_dir/evidence-importer.ts" \
  --manifest "$manifest_path" \
  --output "$output_dir/openpoke.prom" \
  --openmetrics "$output_dir/openpoke.openmetrics" \
  --report "$output_dir/import-report.json"

compose down --volumes --remove-orphans
compose_started=true
compose run --rm --no-deps \
  --entrypoint /bin/promtool \
  prometheus \
  tsdb create-blocks-from openmetrics /evidence/openpoke.openmetrics /prometheus
compose up --detach --wait

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
from_display="$(date --utc --date="$from_utc" '+%Y-%m-%d %H:%M:%S')"
to_display="$(date --utc --date="$to_utc" '+%Y-%m-%d %H:%M:%S')"
expected_range="$from_display to $to_display UTC"
jq -n \
  --arg from "$from_utc" \
  --arg to "$to_utc" \
  --arg run "$failed_run" \
  --argjson from_ms "$from_milliseconds" \
  --argjson to_ms "$to_milliseconds" \
  '{timezone:"UTC",from:$from,to:$to,selected_run:$run,from_milliseconds:$from_ms,to_milliseconds:$to_ms}' \
  > "$output_dir/config/locked-time-range.json"

cp "$observability_dir/compose.yaml" "$output_dir/config/compose.yaml"
cp "$observability_dir/prometheus.yml" "$output_dir/config/prometheus.yml"
cp "$observability_dir/presentation-queries.tsv" "$output_dir/config/presentation-queries.tsv"
cp "$observability_dir/evidence-importer.ts" "$output_dir/config/evidence-importer.ts"
cp "$observability_dir/validate-dashboard-dom.ts" "$output_dir/config/validate-dashboard-dom.ts"
cp -R "$observability_dir/grafana" "$output_dir/config/grafana"

while IFS=$'\t' read -r query_name query; do
  curl --fail --silent --show-error --get \
    --data-urlencode "query=$query" \
    --data-urlencode "time=$to_seconds" \
    "$prometheus_url/api/v1/query" \
    > "$output_dir/prometheus/queries/$query_name.json"
done < "$observability_dir/presentation-queries.tsv"

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

mkdir -p -- "$browser_profile"
for dashboard_uid in "${dashboard_uids[@]}"; do
  dashboard_url="${grafana_url}/d/${dashboard_uid}?orgId=1&from=${from_milliseconds}&to=${to_milliseconds}&timezone=utc&var-run=${failed_run}&kiosk&theme=light"
  diagnostic_path="$output_dir/diagnostics/$dashboard_uid.log"
  if ! chromium \
    --headless=new \
    --no-sandbox \
    --disable-gpu \
    --hide-scrollbars \
    --user-data-dir="$browser_profile" \
    --virtual-time-budget=12000 \
    --window-size=1920,1080 \
    --dump-dom \
    "$dashboard_url" \
    > "$output_dir/dom/$dashboard_uid.html" \
    2> "$diagnostic_path"; then
    cat "$diagnostic_path" >&2
    exit 1
  fi
  if ! bun "$observability_dir/validate-dashboard-dom.ts" \
    "$output_dir/dom/$dashboard_uid.html" \
    "$failed_run" \
    "$expected_range"; then
    cat "$diagnostic_path" >&2
    exit 1
  fi
  if ! chromium \
    --headless=new \
    --no-sandbox \
    --disable-gpu \
    --hide-scrollbars \
    --user-data-dir="$browser_profile" \
    --virtual-time-budget=12000 \
    --window-size=1920,1080 \
    --screenshot="$output_dir/screenshots/$dashboard_uid.png" \
    "$dashboard_url" \
    >> "$diagnostic_path" 2>&1; then
    cat "$diagnostic_path" >&2
    exit 1
  fi
  redacted_diagnostic_path="$diagnostic_path.redacted"
  while IFS= read -r diagnostic_line || [[ -n "$diagnostic_line" ]]; do
    printf '%s\n' "${diagnostic_line//"$output_dir"/<presentation-bundle>}"
  done < "$diagnostic_path" > "$redacted_diagnostic_path"
  mv -- "$redacted_diagnostic_path" "$diagnostic_path"
done
rm -rf -- "$browser_profile"
browser_profile=""
rm -f -- "$manifest_path"
manifest_path=""

if rg --line-number '/home/|source_path|heyimcarlos' "$output_dir"; then
  echo "presentation bundle contains a private source path or username" >&2
  exit 1
fi

(
  cd "$output_dir"
  find . -type f ! -name SEALED-SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    > SEALED-SHA256SUMS
)

mv --no-target-directory -- "$staging_dir" "$final_output_dir"
published=true

echo "OpenPoke presentation bundle sealed: $final_output_dir"
echo "Grafana: $grafana_url/d/openpoke-100k-scorecard?var-run=$failed_run"
