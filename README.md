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
bun run db:seed:reference
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
bun run start:agent-run-worker
```

Build them first with `bun run build`.

The ingress process requires `OSFO_DATABASE_URL`,
`OSFO_EXECUTION_PROFILE_REF`, `OSFO_GLOBAL_NON_TERMINAL_LIMIT`, and
`OSFO_PRINCIPAL_NON_TERMINAL_LIMIT`. Snapshot size, replay retention, stream
polling, and cursor signing have bounded local defaults. Production deployments
set `OSFO_CURSOR_SECRET` explicitly. Set `OSFO_INGRESS_PORT` to override its
default port, 3000.

## Browser reference and UI

Run `bun run dev` after seeding the reference authority to open the browser
Thread client and its ingress process together. Each tab stores one complete
projection and ThreadCursor record in its own session storage. It bootstraps
from a bounded snapshot, applies authenticated replay and live SSE events
crash-consistently, and renders messages only from canonical Thread authority.
The development server proxies `/v1` to ingress on port 3000, so browser HTTP
remains same-origin.

The reference seed is explicit and idempotent. It creates only the local
Principal, authentication session, Thread, and capacity rows named by the
`VITE_OSFO_*` values in `.env`. It does not start PostgreSQL or run migrations.

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
