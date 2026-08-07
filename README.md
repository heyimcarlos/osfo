# Osfo

Osfo is a TypeScript and Effect 4 workspace managed by Bun and Turbo. Production
application entrypoints run on Node 24.

## Workspace commands

```sh
bun install --frozen-lockfile
bun run build
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run db:verify
```

Local development keeps database setup explicit:

```sh
bun run db:up
cp .env.example .env
bun run db:migrate
bun run db:seed:demo
bun run dev
```

The example environment points at the pinned PostgreSQL container on
`127.0.0.1:55432` and includes the non-secret ingress defaults. `bun run
db:down` removes the local database volume.

The Drizzle schema and migration commands are owned by `@osfo/db` and exposed
at the workspace root:

```sh
bun run db:generate -- --name=describe_change
bun run db:check
bun run db:migrate
bun run db:studio
```

Generate and commit SQL migrations for schema changes. Do not use
`drizzle-kit push`; checked-in migrations and the real PostgreSQL verification
gate are the repository authority.

`db:verify` starts the digest-pinned local PostgreSQL service, applies and
verifies every versioned migration, runs the real PostgreSQL admission and HTTP
composition tests, then removes the disposable database volume.

`packages/api` owns the schema-first HTTP contract, generated client shape, and
handlers. `packages/db` owns the Drizzle schema, migrations, PostgreSQL connection
layers, and persistence adapters. The API depends on an Effect-native admission
interface and contains no database access.

The runnable process-role scaffolds are:

```sh
bun run start:ingress
bun run start:outbox-relay
bun run start:agent-run-worker
```

Build them first with `bun run build`.

## Qualification observability

The root `observability` module imports sealed qualification evidence into a
pinned Prometheus and Grafana presentation stack. It is operational tooling,
not a reusable package or an Agent Application. See
[`observability/README.md`](observability/README.md) for its one-command
walkthrough and evidence contract.

The ingress process requires `OSFO_DATABASE_URL`,
`OSFO_EXECUTION_PROFILE_REF`, `OSFO_GLOBAL_NON_TERMINAL_LIMIT`, and
`OSFO_PRINCIPAL_NON_TERMINAL_LIMIT`. Both admission limits are capped at 256 so
recovery work stays bounded. Admission and resume database pools default
to four connections each and are capped at eight through
`OSFO_ADMISSION_DATABASE_POOL_MAX` and `OSFO_RESUME_DATABASE_POOL_MAX`.
Admission capacity is repaired at startup and every 30 seconds by default. Set
`OSFO_ADMISSION_CAPACITY_RECONCILIATION_INTERVAL_MS` to change that interval.
Thread streams also have bounded local defaults for connection count, lifetime,
and unsent event count, bytes, and age. Configure them through the
`OSFO_MAX_STREAM_*` variables in `.env.example`. Snapshot size, replay
retention, stream polling, and cursor signing have bounded local defaults.
Production deployments set `OSFO_CURSOR_SECRET` explicitly. Set
`OSFO_INGRESS_PORT` to override its default port, 3000.

The outbox relay uses one dedicated PostgreSQL notification connection, a
database pool of four connections by default, one Principal-first selector, a
128-record publication window, four recoverable publishers, and a one-second
safety drain. `LISTEN/NOTIFY` is only a wake hint. Startup, listener reconnect,
and the safety drain always recheck durable PostgreSQL authority. Configure the
pool with `OSFO_RELAY_DATABASE_POOL_MAX`; the selected publication topology is
fixed by `OSFO_RELAY_PUBLICATION_WINDOW_SIZE=128`,
`OSFO_RELAY_PUBLISHER_CONCURRENCY=4`, and
`OSFO_RELAY_SAFETY_DRAIN_INTERVAL_MS=1000`.

## Browser reference and UI

Run `bun run dev` after seeding the reference authority to open the browser
Thread client and its ingress process together. Each tab stores one complete
projection and ThreadCursor record in its own session storage. It bootstraps
from a bounded snapshot, applies authenticated replay and live SSE events
crash-consistently, and renders messages only from canonical Thread authority.
The development server proxies `/v1` to ingress on port 3000, so browser HTTP
remains same-origin.

Add `?device=A`, `?device=B`, or `?device=C` to label independent reference
tabs. Each tab displays its own synchronization position while its complete
projection and ThreadCursor remain isolated in that tab's session storage.
`bun run db:verify` exercises this journey through a Vite production build in
real Google Chrome, including independent tab disconnect and resume followed by
PostgreSQL authority reconciliation.

For an interactive demo, the configuration screen can generate a fresh
eight-hour authentication session and Thread when ingress starts with both:

```text
OSFO_RUNTIME_ENVIRONMENT=development
OSFO_DEMO_BOOTSTRAP_CODE_SHA256=<64 lowercase hex SHA-256 of a high-entropy access code>
```

The endpoint is absent when the digest is missing, and ingress fails startup if
the digest is supplied outside development. The operator enters the plaintext
access code only in the browser. It is sent in a request header over HTTPS,
never placed in a URL, web asset, log, or database, and is compared in constant
time. The response is `no-store`, returns the bearer once, and the UI waits for
an explicit Connect before using per-tab session storage. Five attempts are
allowed per ingress process per minute.

The reference seed is explicit and idempotent. It creates only the local
Principal, authentication session, Thread, and capacity rows named by the
`OSFO_REFERENCE_*` values in `.env`. It does not start PostgreSQL or run
migrations.

Reusable chat presentation lives in `@osfo/ui` as shadcn `MessageScroller`,
`Message`, `Bubble`, `Marker`, and composer primitives. The app owns Thread
configuration, Effect atoms, canonical source presentation, and submission
behavior.
Run `bun run dev:web` when ingress is already running.

Run the shadcn CLI from `apps/web` so monorepo aliases route
generated components, hooks, styles, and UI utilities into `packages/ui`:

```sh
cd apps/web
bunx --bun shadcn@4.16.1 add button
```

The theme uses semantic CSS tokens that can be translated by other renderers.
The components themselves use React DOM and Tailwind CSS and are not directly
reusable by a native mobile application.
