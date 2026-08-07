#!/usr/bin/env bash
set -euo pipefail

compose_file="compose.postgres.yaml"
project_name="osfo-migration-verify-$$"
verify_port="$(${NODE_BINARY:-node} -e '
  const net = require("node:net");
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address !== "object" || address === null) process.exit(1);
    process.stdout.write(String(address.port));
    server.close();
  });
')"
mailpit_smtp_port="$(${NODE_BINARY:-node} -e '
  const net = require("node:net");
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address !== "object" || address === null) process.exit(1);
    process.stdout.write(String(address.port));
    server.close();
  });
')"
mailpit_http_port="$(${NODE_BINARY:-node} -e '
  const net = require("node:net");
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address !== "object" || address === null) process.exit(1);
    process.stdout.write(String(address.port));
    server.close();
  });
')"
mailpit_compose_file="apps/agent-run-worker/compose.mailpit.yaml"
mailpit_project_name="osfo-action-mailpit-verify-$$"

cleanup() {
  OSFO_ACTION_MAILPIT_SMTP_PORT="$mailpit_smtp_port" \
    OSFO_ACTION_MAILPIT_HTTP_PORT="$mailpit_http_port" \
    docker compose --project-name "$mailpit_project_name" -f "$mailpit_compose_file" down
  OSFO_POSTGRES_PORT="$verify_port" \
    docker compose --project-name "$project_name" -f "$compose_file" down --volumes
}

trap cleanup EXIT

bun run db:check
bun run build --filter=@osfo/ingress --filter=@osfo/agent-run-worker

OSFO_POSTGRES_PORT="$verify_port" \
  docker compose --project-name "$project_name" -f "$compose_file" up -d --wait
OSFO_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  vitest run --no-file-parallelism packages/db/test/database-access.postgres.test.ts
OSFO_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  bun run db:migrate
OSFO_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  vitest run --no-file-parallelism \
    packages/db/test/database-access-after-migration.postgres.test.ts
OSFO_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  node --conditions=development --import tsx scripts/db/check-readiness.ts
OSFO_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  node --conditions=development --import tsx scripts/verify-migration-upgrade.ts
OSFO_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  bun run --cwd packages/db test:postgres
OSFO_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  bun run --cwd apps/outbox-relay test:postgres
OSFO_ACTION_MAILPIT_SMTP_PORT="$mailpit_smtp_port" \
  OSFO_ACTION_MAILPIT_HTTP_PORT="$mailpit_http_port" \
  docker compose --project-name "$mailpit_project_name" -f "$mailpit_compose_file" up -d --wait
OSFO_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  OSFO_TEST_MAILPIT=1 \
  OSFO_TEST_MAILPIT_SMTP_PORT="$mailpit_smtp_port" \
  OSFO_TEST_MAILPIT_API_ORIGIN="http://127.0.0.1:${mailpit_http_port}" \
  bun run --cwd apps/agent-run-worker test:postgres
OSFO_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  bun run --cwd apps/ingress test:postgres
OSFO_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  bun run --cwd apps/web test:postgres
