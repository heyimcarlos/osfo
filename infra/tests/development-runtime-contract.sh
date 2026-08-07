#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

root=infra/roots/development/runtime

for resource in \
  google_cloud_run_v2_service.transport \
  google_cloud_run_v2_worker_pool.relay \
  google_cloud_run_v2_worker_pool.agentrun \
  google_pubsub_topic_iam_member.relay_publisher \
  google_pubsub_subscription_iam_member.agentrun_subscriber \
  google_compute_region_network_endpoint_group.transport \
  google_compute_security_policy.edge \
  google_compute_managed_ssl_certificate.edge \
  google_monitoring_dashboard.runtime; do
  rg --fixed-strings --quiet "resource \"${resource%.*}\" \"${resource#*.}\"" "$root/main.tf"
done

if rg --quiet 'google_cloud_run_v2_job|apps/database-jobs|OSFO_DATABASE_JOB' "$root"; then
  printf 'database administration and reconciliation must not be Cloud Run jobs\n' >&2
  exit 1
fi

rg --fixed-strings --quiet 'manual_instance_count = var.operating_contract.relay_worker_count' "$root/main.tf"
rg --fixed-strings --quiet 'manual_instance_count = var.operating_contract.agentrun_worker_count' "$root/main.tf"
rg --fixed-strings --quiet 'OSFO_RELAY_PUBLISHER_CONCURRENCY' "$root/main.tf"
rg --fixed-strings --quiet 'OSFO_RELAY_PUBLICATION_WINDOW_SIZE' "$root/main.tf"
rg --fixed-strings --quiet 'OSFO_RELAY_SAFETY_DRAIN_INTERVAL_MS' "$root/main.tf"
rg --fixed-strings --quiet 'OSFO_PUBSUB_STREAM_COUNT' "$root/main.tf"
rg --fixed-strings --quiet 'OSFO_AGENT_RUN_EXECUTION_SLOTS' "$root/main.tf"
rg --fixed-strings --quiet 'OSFO_AGENT_RUN_LEASE_DURATION_MS' "$root/main.tf"
rg --fixed-strings --quiet 'OSFO_AGENT_RUN_LEASE_RENEWAL_INTERVAL_MS' "$root/main.tf"
rg --fixed-strings --quiet 'OSFO_AGENT_RUN_CANCELLATION_POLL_INTERVAL_MS' "$root/main.tf"
rg --fixed-strings --quiet 'OSFO_AGENT_RUN_CANCELLATION_GRACE_MS' "$root/main.tf"
rg --fixed-strings --quiet 'OSFO_AGENT_RUN_TERMINATION_DEADLINE_MS' "$root/main.tf"
rg --fixed-strings --quiet 'OSFO_DATABASE_POOL_MAX' "$root/main.tf"
rg --fixed-strings --quiet \
  'common_proxy_args         = ["--auto-iam-authn", "--private-ip", "--address=0.0.0.0", "--port=5432", local.cloud_sql_connection_name]' \
  "$root/main.tf"
rg --fixed-strings --quiet \
  'database_urls             = { for identity, user in local.database_users : identity => "postgresql://${user}@127.0.0.1:5432/osfo?sslmode=disable" }' \
  "$root/main.tf"
rg --fixed-strings --quiet 'production_candidate = "unqualified"' "$root/main.tf"
rg --fixed-strings --quiet 'six_worker_candidate_qualified = false' "$root/main.tf"
rg --fixed-strings --quiet 'production_qualification       = "MISSING"' "$root/main.tf"
rg --fixed-strings --quiet 'openrouter_minimax_status      = "MISSING"' "$root/main.tf"
rg --fixed-strings --quiet \
  'Production qualification: MISSING. Final us-east4 A/B/C/D admission matrix: FAIL.' \
  "$root/main.tf"
if rg --fixed-strings --quiet 'Production qualification: FAIL/MISSING.' "$root/main.tf"; then
  printf 'runtime evidence must separate overall qualification from the failed admission matrix\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER' "$root/main.tf"
if rg --fixed-strings --quiet 'INGRESS_TRAFFIC_ALL' "$root/main.tf"; then
  printf 'transport must remain internal-and-load-balancer only\n' >&2
  exit 1
fi
edge_address_block=$(sed -n '/resource "google_compute_global_address" "edge" {/,/^}/p' "$root/main.tf")
rg --quiet 'serving_ready\s+= local.runtime_ready && var.serving_enabled' "$root/main.tf"
rg --quiet 'public_edge_ready\s+= local.serving_ready && var.public_hostname != null' "$root/main.tf"
rg --fixed-strings --quiet 'count   = local.serving_ready ? 1 : 0' <<<"$edge_address_block"

for resource in \
  'google_cloud_run_v2_service_iam_member" "transport_public_invoker' \
  'google_compute_region_network_endpoint_group" "transport' \
  'google_compute_security_policy" "edge' \
  'google_compute_backend_service" "transport' \
  'google_compute_managed_ssl_certificate" "edge' \
  'google_compute_url_map" "edge' \
  'google_compute_target_https_proxy" "edge' \
  'google_compute_global_forwarding_rule" "edge'; do
  resource_block=$(sed -n "/resource \"${resource}\" {/,/^}/p" "$root/main.tf")
  rg --fixed-strings --quiet 'local.public_edge_ready ? 1 : 0' <<<"$resource_block"
done
rg --fixed-strings --quiet 'edge_ip_address                = try(google_compute_global_address.edge[0].address, null)' "$root/main.tf"
rg --fixed-strings --quiet 'public_edge_status             = local.public_edge_ready ? "CANDIDATE" : "MISSING"' "$root/main.tf"
rg --fixed-strings --quiet 'serving apply with `public_hostname = null`' \
  docs/openpoke-v1-demo/development-runtime.md
rg --fixed-strings --quiet 'reported as `runtime.edge_ip_address`' \
  docs/openpoke-v1-demo/development-runtime.md
rg --quiet 'protocol\s*=\s*"HTTP"' "$root/main.tf"
rg --fixed-strings --quiet 'Transport request outcomes' "$root/main.tf"
rg --fixed-strings --quiet 'Ordered subscription backlog age' "$root/main.tf"
rg --fixed-strings --quiet 'PostgreSQL connections' "$root/main.tf"
rg --fixed-strings --quiet 'Runtime CPU utilization' "$root/main.tf"
rg --fixed-strings --quiet 'Runtime dependency, lease, fence, cancellation, and rollout logs' "$root/main.tf"
tile_positions=$(awk '/xPos[[:space:]]*=/{ x = $3 } /yPos[[:space:]]*=/{ print x "," $3 }' \
  "$root/main.tf")
if [[ "$tile_positions" != $'0,0\n0,2\n6,2\n0,6\n6,6\n0,10' ]]; then
  printf 'runtime dashboard tiles must use the reviewed non-overlapping mosaic positions\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'OSFO_CURSOR_SECRET' "$root/main.tf"
rg --fixed-strings --quiet 'value_source {' "$root/main.tf"
rg --quiet 'model_adapter_secret_name\s+= "\$\{var\.name_prefix\}-model-adapter"' "$root/main.tf"
rg --fixed-strings --quiet 'var.model_adapter_secret_version != null' "$root/main.tf"
rg --fixed-strings --quiet 'name = "OPENROUTER_API_KEY"' "$root/main.tf"
rg --fixed-strings --quiet 'secret  = local.model_adapter_secret_name' "$root/main.tf"
rg --fixed-strings --quiet 'version = var.model_adapter_secret_version' "$root/main.tf"
[[ $(rg --fixed-strings --count 'name = "OPENROUTER_API_KEY"' "$root/main.tf") == 1 ]]
for secret_version in \
  cursor_secret_version \
  model_adapter_secret_version; do
  variable_block=$(sed -n "/variable \"$secret_version\" {/,/^}/p" "$root/variables.tf")
  rg --fixed-strings --quiet \
    "var.$secret_version == null || can(regex(\"^[1-9][0-9]*\\\\z\", var.$secret_version))" \
    <<<"$variable_block"
done
[[ $(rg --fixed-strings --count \
  'error_message = "The secret version must be null or an exact positive integer string."' \
  "$root/variables.tf") == 2 ]]
secret_version_test="$root/tests/secret-version-validation.tftest.hcl"
[[ $(rg --count '^run "' "$secret_version_test") == 12 ]]
[[ $(rg --fixed-strings --count 'expect_failures = [var.' "$secret_version_test") == 10 ]]
rg --fixed-strings --quiet 'run "accept_positive_integer_versions"' "$secret_version_test"
for invalid_case in latest zero whitespace newline nonnumeric; do
  rg --quiet "^run \"reject_.*_$invalid_case\"" "$secret_version_test"
done
rg --fixed-strings --quiet \
  'infra/scripts/terraform-ci.sh -chdir=infra/roots/development/runtime test' \
  .github/workflows/terraform.yml
if rg --quiet '^\s*timeout_sec\s*=' "$root/main.tf"; then
  printf 'serverless NEG backend services must not configure timeout_sec\n' >&2
  exit 1
fi
if rg --ignore-case --quiet 'OSFO_MODEL_BINDING|OSFO_OPENROUTER_MODEL|OSFO_DETERMINISTIC_MODEL_DELAY_MS|openai' "$root"; then
  printf 'runtime must use only the immutable OpenRouter MiniMax profile\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'OSFO_DETERMINISTIC_QUALIFICATION_MODEL_DELAY_MS' \
  apps/agent-run-worker/src/main.ts
rg --line-regexp --quiet 'OPENROUTER_API_KEY=' .env.example
if rg --quiet 'OSFO_OPENROUTER_MODEL|OPENAI_API_KEY' .env.example; then
  printf 'the immutable profile must own the model and OpenRouter must be the only provider secret\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.22.0@sha256:' "$root/image-digests.json"
rg --fixed-strings --quiet \
  'us-east4-docker.pkg.dev/osfo-development-318708913/osfo/application@sha256:dda45cf1dc4bf438e8b49314bdbe0bc194660f92fd8d5334bc1f575610ecc1a1' \
  "$root/image-digests.json"

jq -e '
  .platform_ready == true
  and .serving_enabled == true
  and .public_hostname == "34.117.18.9.sslip.io"
  and .cursor_secret_version == "1"
  and .model_adapter_secret_version == "1"
  and .execution_profile_ref == "oz.openrouter.minimax.minimax-m3.chat-completions.v1"
  and (has("execution_profiles") | not)
  and .operating_contract.relay_worker_count == 1
  and .operating_contract.relay_publisher_count == 4
  and .operating_contract.agentrun_worker_count == 6
  and .operating_contract.agentrun_streams_per_worker == 4
  and .operating_contract.agentrun_execution_slots_per_worker == 32
  and .operating_contract.agentrun_db_pool_connections == 8
  and .operating_contract.agentrun_lease_duration_ms == 30000
  and .operating_contract.agentrun_lease_renewal_interval_ms == 10000
  and .operating_contract.agentrun_cancellation_poll_interval_ms == 100
  and .operating_contract.agentrun_cancellation_grace_ms == 100
  and .operating_contract.agentrun_termination_deadline_ms == 1000
' "$root/development.tfvars.json" >/dev/null

if rg --quiet 'VITE_OSFO_AUTHENTICATION_TOKEN|VITE_OSFO_THREAD_ID' \
  apps/web/src/main.tsx apps/web/src/configuration-required.tsx Containerfile "$root"; then
  printf 'browser authority must not be compiled into Vite or Terraform\n' >&2
  exit 1
fi

rg --fixed-strings --quiet 'referenceClientAuthorityStorageKey' apps/web/src/main.tsx
rg --fixed-strings --quiet 'type="password"' apps/web/src/configuration-required.tsx
rg --fixed-strings --quiet 'USER node' Containerfile
rg --line-regexp --quiet '\.env' .dockerignore
[[ $(rg --fixed-strings --count '@sha256:' Containerfile) == 3 ]]
rg --fixed-strings --quiet 'docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f' .github/workflows/development-runtime-image.yml
rg --fixed-strings --quiet 'driver: docker-container' .github/workflows/development-runtime-image.yml
rg --fixed-strings --quiet 'docker buildx build' .github/workflows/development-runtime-image.yml
buildx_setup_line=$(rg --fixed-strings --line-number 'docker/setup-buildx-action@' .github/workflows/development-runtime-image.yml | cut -d: -f1)
build_command_line=$(rg --fixed-strings --line-number 'docker buildx build' .github/workflows/development-runtime-image.yml | cut -d: -f1)
if ((buildx_setup_line >= build_command_line)); then
  printf 'docker-container Buildx setup must precede the image build\n' >&2
  exit 1
fi
rg --fixed-strings --quiet -- '--provenance=true' .github/workflows/development-runtime-image.yml
rg --fixed-strings --quiet -- '--sbom=true' .github/workflows/development-runtime-image.yml
rg --fixed-strings --quiet -- '--push' .github/workflows/development-runtime-image.yml
rg --fixed-strings --quiet 'containerimage.digest' .github/workflows/development-runtime-image.yml
rg --fixed-strings --quiet 'sha256:[0-9a-f]{64}' .github/workflows/development-runtime-image.yml
rg --fixed-strings --quiet 'docker buildx imagetools inspect' .github/workflows/development-runtime-image.yml
rg --fixed-strings --quiet 'github.ref == '\''refs/heads/main'\''' .github/workflows/development-runtime-image.yml
rg --fixed-strings --quiet '"cursor-signing"' infra/modules/data-authority/main.tf
if rg --fixed-strings --quiet '"reference-client-auth"' infra/modules/data-authority/main.tf ||
  rg --fixed-strings --quiet '"database-admin-url"' infra/modules/data-authority/main.tf; then
  printf 'operator-only database credentials must not have Terraform secret containers\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'runtime_transport_cursor' infra/roots/foundation/main.tf
rg --fixed-strings --quiet 'runtime_agentrun' infra/roots/foundation/main.tf
rg --fixed-strings --quiet 'secret   = "model-adapter"' infra/roots/foundation/main.tf
rg --fixed-strings --quiet 'development_runtime_act_as' infra/roots/foundation/main.tf
rg --fixed-strings --quiet 'development_runtime_service_consumer' infra/roots/foundation/main.tf
for script in development-runtime-database.sh development-runtime-reconciliation.sh development-runtime-smoke.sh development-runtime-recovery.sh development-runtime-absent.sh; do
  bash -n "infra/tests/$script"
done
bash infra/tests/development-runtime-agent-run-outcome-contract.sh
for operator_script in \
  scripts/db/approved-database-proxy.ts \
  scripts/db/bootstrap-access.ts \
  scripts/db/seed-demo.ts \
  scripts/db/check-readiness.ts \
  scripts/qualification/reconcile-agent-run.ts; do
  [[ -f "$operator_script" ]]
done
for proxy_script in \
  scripts/db/bootstrap-access.ts \
  scripts/db/check-readiness.ts \
  scripts/db/seed-demo.ts \
  scripts/qualification/reconcile-agent-run.ts; do
  [[ $(rg --fixed-strings --count 'requireApprovedDatabaseProxy' "$proxy_script") == 2 ]]
done
rg --fixed-strings --quiet 'databaseAdminUrl: Config.redacted("OSFO_DATABASE_ADMIN_URL")' \
  scripts/db/bootstrap-access.ts
rg --fixed-strings --quiet 'Schema.decodeUnknownEffect(Schema.URLFromString)' \
  scripts/db/bootstrap-access.ts
rg --fixed-strings --quiet 'databaseAdminUrl: Redacted.make(databaseAdminUrl)' \
  scripts/db/bootstrap-access.ts
for reconciliation_caller in \
  infra/tests/development-runtime-smoke.sh \
  infra/tests/development-runtime-recovery.sh; do
  rg --fixed-strings --quiet 'infra/tests/development-runtime-reconciliation.sh' \
    "$reconciliation_caller"
done
rg --fixed-strings --quiet 'bun run db:migrate' infra/tests/development-runtime-database.sh
rg --fixed-strings --quiet '"db:migrate": "drizzle-kit migrate --config=drizzle.config.ts"' \
  packages/db/package.json
if rg --fixed-strings --quiet 'migrateTestDatabase' packages/db/src/index.ts; then
  printf 'the programmatic migrator must remain verification-only\n' >&2
  exit 1
fi
if rg --ignore-case --quiet 'drizzle-kit push|drizzle-kit push:pg' \
  package.json packages scripts docs infra/roots infra/modules; then
  printf 'production schema changes must use reviewed generated migrations, never push\n' >&2
  exit 1
fi
absence_script=infra/tests/development-runtime-absent.sh
rg --fixed-strings --quiet 'gcloud auth list' "$absence_script"
rg --fixed-strings --quiet 'gcloud projects describe "$project_id"' "$absence_script"
rg --fixed-strings --quiet -- "--format='json(account,status)'" "$absence_script"
rg --fixed-strings --quiet -- "--format='json(projectId)'" "$absence_script"
rg --fixed-strings --quiet 'and .projectId == $project_id' "$absence_script"
for list_command in \
  'gcloud run services list' \
  'gcloud beta run worker-pools list' \
  'gcloud compute network-endpoint-groups list' \
  'gcloud compute backend-services list' \
  'gcloud compute ssl-certificates list' \
  'gcloud compute addresses list' \
  'gcloud compute security-policies list' \
  'gcloud compute url-maps list' \
  'gcloud compute target-https-proxies list' \
  'gcloud compute forwarding-rules list'; do
  rg --fixed-strings --quiet "$list_command" "$absence_script"
done
if rg --quiet 'require_absent|services describe|worker-pools describe|jobs describe|network-endpoint-groups describe|backend-services describe|ssl-certificates describe|addresses describe|security-policies describe|url-maps describe|target-https-proxies describe|forwarding-rules describe|2>&1' "$absence_script"; then
  printf 'runtime absence evidence must use successful list queries without raw provider diagnostics\n' >&2
  exit 1
fi
bash -n infra/tests/development-runtime-absent-contract.sh
rg --fixed-strings --quiet 'development-runtime-absent-contract.sh' \
  infra/test/terraform-foundation.test.ts
rg --fixed-strings --quiet 'productionQualification: "MISSING"' infra/tests/development-runtime-smoke.sh
rg --fixed-strings --quiet 'exit 2' infra/tests/development-runtime-smoke.sh
rg --fixed-strings --quiet 'oz.openrouter.minimax.minimax-m3.chat-completions.v1' infra/tests/development-runtime-smoke.sh
rg --fixed-strings --quiet 'openrouter.chat-completions.minimax.minimax-m3.v1' infra/tests/development-runtime-smoke.sh
rg --fixed-strings --quiet 'reportedUsageAttemptCount == "1"' infra/tests/development-runtime-smoke.sh
rg --fixed-strings --quiet 'positiveReasoningUsageAttemptCount == "1"' infra/tests/development-runtime-smoke.sh
rg --fixed-strings --quiet 'run.googleapis.com/manualInstanceCount' infra/tests/development-runtime-smoke.sh
rg --fixed-strings --quiet 'development-runtime-agent-run-outcome.jq' infra/tests/development-runtime-smoke.sh
rg --fixed-strings --quiet 'AgentRunFailed before authoritative output completed' infra/tests/development-runtime-smoke.sh
rg --fixed-strings --quiet 'MISSING: replacement-before-provider-contact' infra/tests/development-runtime-recovery.sh
if rg --quiet 'OSFO_DETERMINISTIC_MODEL_DELAY_MS|processReplacement: "PASS"' infra/tests/development-runtime-recovery.sh; then
  printf 'deployed OpenRouter recovery must not claim deterministic delay evidence\n' >&2
  exit 1
fi
rg --fixed-strings --quiet '| Production qualification | MISSING |' \
  docs/openpoke-v1-demo/development-runtime.md
rg --fixed-strings --quiet '| Final `us-east4` A/B/C/D admission matrix | FAIL |' \
  docs/openpoke-v1-demo/development-runtime.md
rg --fixed-strings --quiet -- '-> separate qualification reconciliation and duplicate-delivery proof' \
  docs/openpoke-v1-demo/development-runtime.md
if rg --quiet 'duplicate-delivery and worker-replacement recovery proof|sequence supplies rollout, process-replacement' \
  docs/openpoke-v1-demo/development-runtime.md; then
  printf 'deployed evidence must not overstate process replacement qualification\n' >&2
  exit 1
fi
rg --fixed-strings --quiet 'relay publisher binding' infra/tests/development-runtime-absent.sh
rg --fixed-strings --quiet 'AgentRun subscriber binding' infra/tests/development-runtime-absent.sh

printf 'PASS: development runtime demo topology, credential boundary, digest pins, and honest qualification labels\n'
