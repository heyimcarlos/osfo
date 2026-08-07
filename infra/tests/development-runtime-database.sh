#!/usr/bin/env bash

set -euo pipefail

database_admin_url=${OSFO_DATABASE_ADMIN_URL:-}
database_url=${OSFO_DATABASE_URL:-}
runtime_roles=${OSFO_DATABASE_RUNTIME_ROLES:-}
authentication_token=${OSFO_REFERENCE_AUTHENTICATION_TOKEN:-}
thread_id=${OSFO_REFERENCE_THREAD_ID:-}

missing=0
for input in \
  database_admin_url \
  database_url \
  runtime_roles \
  authentication_token \
  thread_id; do
  if [[ -z ${!input} ]]; then
    printf 'MISSING: operator database input %s\n' "$input" >&2
    missing=1
  fi
done
if ((missing != 0)); then
  exit 2
fi
if [[ "$database_admin_url" != "$database_url" ]]; then
  printf 'FAIL: bootstrap and Drizzle migrations must use the same operator admin authority\n' >&2
  exit 1
fi

bun run db:bootstrap-access
printf 'PASS: one-time PostgreSQL IAM grants completed over the approved private connection\n'

bun run db:migrate
printf 'PASS: reviewed generated Drizzle SQL migrations completed\n'

bun run db:seed:demo
printf 'PASS: explicit demo authority and thread seed completed\n'

bun run db:ready
printf 'PASS: database migration version readiness confirmed\n'
printf 'PASS: serving runtime may be enabled by a fresh reviewed Terraform plan\n'
