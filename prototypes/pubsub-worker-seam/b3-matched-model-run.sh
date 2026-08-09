#!/usr/bin/env bash
set -euo pipefail

prototype_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
evidence_root="$prototype_dir/evidence/b3-matched-model-152"

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY is required}"
if [[ -e "$evidence_root" ]]; then
  echo "Refusing to overwrite matched model evidence: $evidence_root" >&2
  exit 1
fi

export B3_EXPERIMENT=matched-model-152
export B3_MODEL_PROVIDER=openrouter
export B3_OPENROUTER_MODEL=openai/gpt-5-nano
export B3_AGENT_RUNS_PER_MESSAGE=1
export B3_SEQUENCE_STRIPES=64
export B3_INFLIGHT_AGENT_RUNS=32768
export B3_INFLIGHT_BUDGET_STRIPES=64
export B3_WORKER_CONCURRENCY=32
export B3_WORKER_SLOTS=32
export B3_WORKER_DB_POOL=4
export B3_WORKER_MIN_INSTANCES=0
export B3_WORKER_MAX_INSTANCES=16
export B3_INGRESS_CONCURRENCY=80
export B3_INGRESS_MIN_INSTANCES=0
export B3_RELAY_PUBLISHER_WORKERS=4
export B3_RESET_SUBSCRIPTION=0
export B3_LOAD_PRINCIPAL_COUNT=0
export B3_CAPTURE_FULL_TOPOLOGY=0

resources_may_exist=false
teardown_complete=false

b3() {
  "$prototype_dir/b3-run.sh" "$@"
}

openrouter_usage() {
  printf 'header = "Authorization: Bearer %s"\n' "$OPENROUTER_API_KEY" |
    curl --config - --fail --silent --show-error https://openrouter.ai/api/v1/key |
    jq -e '.data.usage'
}

receipt_slo() {
  local lane=$1
  gzip -cd "$evidence_root/load/$lane/caller-samples.jsonl.gz" |
    jq -s '{
      threshold_ms:1000,
      within_threshold:([.[] | select(.latency_ms <= 1000)] | length),
      within_threshold_ratio:(([.[] | select(.latency_ms <= 1000)] | length) / length),
      verdict:(if (([.[] | select(.latency_ms <= 1000)] | length) / length) >= 0.999 then "PASS" else "FAIL" end)
    }'
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$resources_may_exist" == true && "$teardown_complete" == false ]]; then
    b3 teardown || true
  fi
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$evidence_root"
usage_before=$(openrouter_usage)
resources_may_exist=true
b3 provision
b3 load model-smoke-1 1 3 1
jq -e '
  .accepted_incoming == 3 and
  .authoritative_agent_runs == 3 and
  .succeeded_agent_runs == 3 and
  .nonterminal_agent_runs == 0 and
  .model_calls == 3 and
  .verdict == "PASS"
' "$evidence_root/load/model-smoke-1-1/audit.json" >/dev/null

b3 load warm-up-23 23 10 1
b3 load target-232 232 60 1
b3 load stress-464 464 15 1
b3 load post-stress-23 23 10 1

sleep 30
usage_after=$(openrouter_usage)
source_revision=$(git -C "$prototype_dir/../.." rev-parse HEAD)
jq -n \
  --argjson before "$usage_before" \
  --argjson after "$usage_after" \
  '{usageBeforeUsd:$before,usageAfterUsd:$after,measuredCostUsd:($after-$before)}' \
  >"$evidence_root/model-usage.json"

jq -n \
  --slurpfile warm "$evidence_root/load/warm-up-23-1/caller-summary.json" \
  --slurpfile target "$evidence_root/load/target-232-1/caller-summary.json" \
  --slurpfile stress "$evidence_root/load/stress-464-1/caller-summary.json" \
  --slurpfile recovery "$evidence_root/load/post-stress-23-1/caller-summary.json" \
  --slurpfile warmAudit "$evidence_root/load/warm-up-23-1/audit.json" \
  --slurpfile targetAudit "$evidence_root/load/target-232-1/audit.json" \
  --slurpfile stressAudit "$evidence_root/load/stress-464-1/audit.json" \
  --slurpfile recoveryAudit "$evidence_root/load/post-stress-23-1/audit.json" \
  --arg sourceRevision "$source_revision" \
  --argjson warmSlo "$(receipt_slo warm-up-23-1)" \
  --argjson targetSlo "$(receipt_slo target-232-1)" \
  --argjson stressSlo "$(receipt_slo stress-464-1)" \
  --argjson recoverySlo "$(receipt_slo post-stress-23-1)" '
  def lane($name; $rate; $duration; $caller; $audit; $slo): {
    name:$name,
    rate_per_second:$rate,
    duration_seconds:$duration,
    offered:$caller[0].count,
    accepted:($caller[0].outcomes | map(select(.outcome == "accepted") | .count) | add // 0),
    caller_to_receipt_ms:$caller[0].latency_ms,
    receipt_slo:$slo,
    authoritative_agent_runs:$audit[0].authoritative_agent_runs,
    succeeded_agent_runs:$audit[0].succeeded_agent_runs,
    claim_to_terminal_ms:$audit[0].claim_to_terminal_ms,
    model_calls:$audit[0].model_calls,
    nonterminal_agent_runs:$audit[0].nonterminal_agent_runs,
    audit_verdict:$audit[0].verdict
  };
  {
    schema_version:1,
    source_revision:$sourceRevision,
    candidate:"gcp-b3-transactional-outbox-openrouter",
    model:"openai/gpt-5-nano",
    system_prompt:"Reply with exactly OK and no other text.",
    output_token_cap:8,
    agent_runs_per_message:1,
    limitations:[
      "Both candidates used openai/gpt-5-nano, the same system instruction, current user message, eight-token output cap, one agent turn per message, and the same arrival lanes.",
      "Cloudflare Think assembled accumulated account session history. The reused GCP B3 harness sent the fixed system and current user messages without prior session history.",
      "OpenRouter response token and cache telemetry is MISSING. model-usage.json records only the immediate provider account usage delta.",
      "The GCP candidate used the prior B3 transactional-outbox topology with at most 16 workers and 32 concurrent handlers per worker. Cloudflare used 1,024 named account-agent Durable Objects.",
      "The reused GCP lane carried no Principal or Thread identity. Cloudflare distributed requests across 1,024 account identities.",
      "The client ran from the local Toronto development host. This is a non-production characterization."
    ],
    lanes:[
      lane("warm-up-23";23;10;$warm;$warmAudit;$warmSlo),
      lane("target-232";232;60;$target;$targetAudit;$targetSlo),
      lane("stress-464";464;15;$stress;$stressAudit;$stressSlo),
      lane("post-stress-23";23;10;$recovery;$recoveryAudit;$recoverySlo)
    ]
  }
' >"$evidence_root/results.json"

b3 teardown
teardown_complete=true
b3 seal
echo "Matched GCP model evidence: $evidence_root"
