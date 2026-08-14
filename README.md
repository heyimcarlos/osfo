# Osfo

Osfo is a personal AI agent for non-technical users. This workspace contains the
Cloudflare Worker application, shared UI modules, an authentication-aware web
preview, and the accepted product and architecture decisions.

## Product direction

- [CONTEXT.md](CONTEXT.md) defines the domain language.
- [The Osfo v1 specification](docs/specs/osfo-v1.md) defines the launch product and
  target architecture.
- [Current ADRs](docs/adr/) record accepted Cloudflare, Think, and storage
  decisions.
- [The implementation map](https://github.com/heyimcarlos/osfo/issues/167)
  owns active work.

## Current workspace

The `@osfo/worker` application is the Cloudflare composition root and owns Osfo
product behavior. The `@osfo/ui` package contains generic shared React DOM,
Tailwind CSS, and shadcn/ui presentation modules. The `@osfo/web` application
signs in through the Worker and then previews the chat modules with local sample
state. Chat transport, synchronization, and product business logic are not
connected yet.

Run the web application and Worker together:

```sh
bun dev
```

Turbo starts the web application at `http://localhost:5173` and the Worker at
`http://localhost:8787`.

Product behavior will be added as focused modules inside `apps/worker`. Extract
a workspace package only after a second consumer or supported public interface
proves the seam.

The web preview uses `http://localhost:8787/auth` in development and
`https://api.osfo.ai/auth` in production. Each application owns its local
environment file. Copy `apps/web/.env.example` to `apps/web/.env` and
`apps/worker/.env.example` to `apps/worker/.env`. Packages do not load
environment files.

The Worker uses stage-local Cloudflare bindings declared in
`apps/worker/wrangler.jsonc`. For local Worker development, set `DATABASE_URL`
in `apps/worker/.env` to the direct PostgreSQL connection string. The Worker
development command maps it to Wrangler's local Hyperdrive binding. To provision
a development stack with the same Worker configuration, run:

```sh
bunx alchemy dev --env-file apps/worker/.env
```

Production deployment receives these values from CI or the deployment secret
store, not from a committed environment file.

The root database commands target the development PostgreSQL database declared
by `DATABASE_URL` in `apps/worker/.env`:

```sh
bun run db:check
bun run db:generate
bun run db:migrate
bun run db:push
bun run db:studio
```

Use `db:migrate` for committed migrations. Use `db:push` only for disposable
local development. Alchemy applies the same committed migration files to the
Neon databases it manages, so do not run both migration systems against the
same database.

The selected Twilio Verify Service must define the programmable rate-limit key
`phone_number`. Configure one bucket for one send per 30 seconds and one bucket
for five sends per hour. The Worker supplies this key on every SMS request.

## Verification

Use Bun 1.3.14 and Node 24.18.0.

```sh
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

GitHub Actions runs the same commands.
