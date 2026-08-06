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

cleanup() {
  OSFO_POSTGRES_PORT="$verify_port" \
    docker compose --project-name "$project_name" -f "$compose_file" down --volumes
}

trap cleanup EXIT

bun run build --filter=@osfo/ingress

OSFO_POSTGRES_PORT="$verify_port" \
  docker compose --project-name "$project_name" -f "$compose_file" up -d --wait
OSFO_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  node --conditions=development --import tsx scripts/verify-migrations.ts
OSFO_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  bun run --cwd packages/db test:postgres
OSFO_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${verify_port}/osfo_lifecycle" \
  bun run --cwd apps/ingress test:postgres
