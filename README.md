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

`db:verify` starts the digest-pinned local PostgreSQL service, applies the
versioned empty baseline, verifies it, then removes the disposable database
volume.

The runnable process-role scaffolds are:

```sh
bun run start:native-thread-transport
bun run start:agent-run-worker
```

Build them first with `bun run build`.

## Browser reference and UI

Run `bun run dev:web` to open the minimal browser reference client. It
consumes the `@osfo/ui` button and stylesheet through public package exports.
Run the shadcn CLI from `apps/web` so monorepo aliases route
generated components, hooks, styles, and UI utilities into `packages/ui`:

```sh
cd apps/web
bunx --bun shadcn@4.16.1 add button
```

The theme uses semantic CSS tokens that can be translated by other renderers.
The components themselves use React DOM and Tailwind CSS and are not directly
reusable by a native mobile application.
