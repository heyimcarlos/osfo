#!/usr/bin/env bash
set -euo pipefail

observability_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$observability_dir/.." && pwd)"
final_output_dir="${1:?usage: run-presentation.sh OUTPUT_DIR [CATALOG_MANIFEST]}"
catalog_manifest="${2:-$observability_dir/evidence-catalog.manifest.json}"
prometheus_port="${OSFO_OPENPOKE_PROMETHEUS_PORT:-19090}"
grafana_port="${OSFO_OPENPOKE_GRAFANA_PORT:-13000}"
prometheus_url="http://127.0.0.1:${prometheus_port}"
grafana_url="http://127.0.0.1:${grafana_port}"
compose_project="${OSFO_OPENPOKE_COMPOSE_PROJECT:-osfo-openpoke-evidence}"

if [[ ! "$compose_project" =~ ^osfo-openpoke-evidence(-[a-z0-9][a-z0-9-]{0,47})?$ ]]; then
  echo "compose project must use the dedicated osfo-openpoke-evidence namespace" >&2
  exit 1
fi

final_output_dir="$(realpath --canonicalize-missing -- "$final_output_dir")"
catalog_manifest="$(realpath -- "$catalog_manifest")"
if [[ -e "$final_output_dir" || -L "$final_output_dir" ]]; then
  echo "refusing to overwrite presentation bundle: $final_output_dir" >&2
  exit 1
fi
if [[ ! -f "$catalog_manifest" || -L "$catalog_manifest" ]]; then
  echo "catalog manifest must be a regular non-link file: $catalog_manifest" >&2
  exit 1
fi

output_parent="$(dirname "$final_output_dir")"
output_name="$(basename "$final_output_dir")"
mkdir -p -- "$output_parent"
staging_dir="$(mktemp -d --tmpdir="$output_parent" ".$output_name.staging.XXXXXX")"
chmod 0755 -- "$staging_dir"
output_dir="$staging_dir"
browser_profile="$staging_dir/.browser-profile"
compose_started=false
published=false

compose() {
  OSFO_OPENPOKE_EVIDENCE_DIR="$output_dir" \
    OSFO_OPENPOKE_PROMETHEUS_PORT="$prometheus_port" \
    OSFO_OPENPOKE_GRAFANA_PORT="$grafana_port" \
    docker compose \
      --project-name "$compose_project" \
      --file "$observability_dir/compose.yaml" \
      "$@"
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  if [[ -d "$browser_profile" ]]; then
    rm -rf -- "$browser_profile"
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

mkdir -p \
  "$output_dir/config" \
  "$output_dir/dom" \
  "$output_dir/diagnostics" \
  "$output_dir/grafana/api" \
  "$output_dir/prometheus/queries" \
  "$output_dir/screenshots"

(
  cd "$repository_root"
  bun "$observability_dir/evidence-catalog.ts" \
    --manifest "$catalog_manifest" \
    --metrics "$output_dir/openpoke.prom" \
    --openmetrics "$output_dir/openpoke.openmetrics" \
    --catalog "$output_dir/normalized-catalog.json" \
    --coverage "$output_dir/coverage-report.json" \
    --import-report "$output_dir/import-report.json"
)

compose down --volumes --remove-orphans
compose_started=true
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

for _ in {1..30}; do
  if curl --fail --silent --show-error --get \
    --data-urlencode 'query=count(openpoke_catalog_record_info)' \
    "$prometheus_url/api/v1/query" \
    | jq -e '.data.result[0].value[1] | tonumber > 0' > /dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error --get \
  --data-urlencode 'query=count(openpoke_catalog_record_info)' \
  "$prometheus_url/api/v1/query" \
  > "$output_dir/prometheus/catalog-ready.json"
jq -e '.data.result[0].value[1] | tonumber > 0' \
  "$output_dir/prometheus/catalog-ready.json" > /dev/null

cp "$observability_dir/compose.yaml" "$output_dir/config/compose.yaml"
cp "$observability_dir/prometheus.yml" "$output_dir/config/prometheus.yml"
cp "$observability_dir/presentation-queries.tsv" "$output_dir/config/presentation-queries.tsv"
cp "$catalog_manifest" "$output_dir/config/evidence-catalog.manifest.json"
cp -R "$observability_dir/grafana" "$output_dir/config/grafana"

while IFS=$'\t' read -r query_name query; do
  [[ -n "$query_name" && -n "$query" ]] || continue
  curl --fail --silent --show-error --get \
    --data-urlencode "query=$query" \
    "$prometheus_url/api/v1/query" \
    > "$output_dir/prometheus/queries/$query_name.json"
done < "$observability_dir/presentation-queries.tsv"

curl --fail --silent --show-error "$prometheus_url/api/v1/status/config" \
  > "$output_dir/prometheus/runtime-config.json"
curl --fail --silent --show-error "$prometheus_url/api/v1/status/buildinfo" \
  > "$output_dir/prometheus/build-info.json"

dashboard_uids=(
  openpoke-executive-summary
  openpoke-development-runtime
  openpoke-load-admission
  openpoke-postgres-capacity
  openpoke-durability-recovery
  openpoke-multi-device-streaming
  openpoke-toolcalls-actions
  openpoke-evidence-catalog
)
dashboard_aliases=(
  "Production qualification"
  "Runtime smoke"
  "Authoritative admission matrix A/B/C/D"
  "PostgreSQL matrix comparison"
  "Recovery fleet screen: 4, 6, and 8 workers"
  "Streaming journeys and limitations"
  "External-action requirement map"
  "Coverage by source"
)
for dashboard_uid in "${dashboard_uids[@]}"; do
  curl --fail --silent --show-error "$grafana_url/api/dashboards/uid/$dashboard_uid" \
    > "$output_dir/grafana/api/$dashboard_uid.json"
done

mkdir -p -- "$browser_profile"
to_seconds="$(date --utc +%s)"
from_seconds="$((to_seconds - 3600))"
from_milliseconds="$((from_seconds * 1000))"
to_milliseconds="$((to_seconds * 1000))"
from_display="$(date --utc --date="@$from_seconds" '+%Y-%m-%d %H:%M:%S')"
to_display="$(date --utc --date="@$to_seconds" '+%Y-%m-%d %H:%M:%S')"
expected_range="$from_display to $to_display UTC"
for dashboard_index in "${!dashboard_uids[@]}"; do
  dashboard_uid="${dashboard_uids[$dashboard_index]}"
  dashboard_alias="${dashboard_aliases[$dashboard_index]}"
  dashboard_url="${grafana_url}/d/${dashboard_uid}?orgId=1&from=${from_milliseconds}&to=${to_milliseconds}&timezone=utc&var-environment=development&kiosk&theme=light"
  diagnostic_path="$output_dir/diagnostics/$dashboard_uid.log"
  validation_path="$diagnostic_path.validation"
  capture_passed=false
  for capture_attempt in {1..3}; do
    if chromium \
      --headless=new \
      --no-sandbox \
      --disable-gpu \
      --hide-scrollbars \
      --user-data-dir="$browser_profile" \
      --virtual-time-budget=15000 \
      --window-size=1920,1080 \
      --dump-dom \
      --screenshot="$output_dir/screenshots/$dashboard_uid.png" \
      "$dashboard_url" \
      > "$output_dir/dom/$dashboard_uid.html" \
      2> "$diagnostic_path" \
      && bun "$observability_dir/validate-dashboard-dom.ts" \
        "$output_dir/dom/$dashboard_uid.html" \
        "$output_dir/screenshots/$dashboard_uid.png" \
        "$dashboard_alias" \
        "$expected_range" \
        2> "$validation_path"; then
      capture_passed=true
      break
    fi
    sleep "$capture_attempt"
  done
  if [[ "$capture_passed" != true ]]; then
    if [[ -f "$validation_path" ]]; then
      cat "$validation_path" >&2
    fi
    sed "s|$output_dir|<presentation-bundle>|g" "$diagnostic_path" >&2
    exit 1
  fi
  rm -f -- "$validation_path"
  sed "s|$output_dir|<presentation-bundle>|g" "$diagnostic_path" > "$diagnostic_path.redacted"
  mv -- "$diagnostic_path.redacted" "$diagnostic_path"
done
rm -rf -- "$browser_profile"

if rg --line-number \
  '/home/|/Users/|postgresql://|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|Bearer [A-Za-z0-9._-]+|OPENROUTER_API_KEY=' \
  "$output_dir"; then
  echo "presentation bundle contains a private path or credential-shaped value" >&2
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

echo "PASS: OpenPoke evidence cockpit sealed at $final_output_dir"
echo "Grafana: $grafana_url/d/openpoke-executive-summary?var-environment=development"
