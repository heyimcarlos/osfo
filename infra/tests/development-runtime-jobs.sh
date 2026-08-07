#!/usr/bin/env bash

set -euo pipefail

project_id=${GCP_DEVELOPMENT_PROJECT_ID:-}
region=${GCP_REGION:-us-east4}
prefix=${OSFO_NAME_PREFIX:-osfo-dev}

if [[ -z "$project_id" ]]; then
  printf 'MISSING: GCP_DEVELOPMENT_PROJECT_ID is required\n' >&2
  exit 2
fi

for job in database-bootstrap migration reference-seed; do
  if ! gcloud run jobs describe "$prefix-$job" --project="$project_id" --region="$region" \
    >/dev/null 2>&1; then
    printf 'MISSING: Cloud Run job %s-%s is not deployed\n' "$prefix" "$job" >&2
    exit 2
  fi
done

gcloud run jobs execute "$prefix-database-bootstrap" --project="$project_id" --region="$region" --wait
printf 'PASS: PostgreSQL IAM migration and runtime privileges were bootstrapped privately\n'

gcloud run jobs execute "$prefix-migration" --project="$project_id" --region="$region" --wait
printf 'PASS: database migrations completed through the private Cloud SQL job\n'

gcloud run jobs execute "$prefix-database-bootstrap" --project="$project_id" --region="$region" --wait
printf 'PASS: runtime grants were reconciled after migration\n'

gcloud run jobs execute "$prefix-reference-seed" --project="$project_id" --region="$region" --wait
printf 'PASS: idempotent reference authority seed completed through the private Cloud SQL job\n'

printf 'PASS: runtime serving may be enabled by a fresh reviewed Terraform plan\n'
