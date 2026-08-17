# Osfo

Osfo is a personal AI agent for non-technical users. This workspace contains the
Cloudflare Worker application, shared UI modules, an authentication-aware web
preview, and the accepted product and architecture decisions.

## Product direction

- [CONTEXT.md](CONTEXT.md) defines the domain language.
- [The Osfo v1 specification](docs/specs/osfo-v1.md) defines the launch product and
  target architecture.
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
in `apps/worker/.env` to the development branch connection string. The Worker
development command maps it to Wrangler's local Hyperdrive binding.

Alchemy owns one PostgreSQL 18 Neon project named `osfo.ai`. Deploy production
first because that stage owns the project and its default `production` branch.
Set `NEON_ORG_ID` to the Osfo Neon organization ID, then inspect and apply the
production plan:

```sh
bunx alchemy deploy --dry-run --stage production --env-file apps/worker/.env
bunx alchemy deploy --stage production --env-file apps/worker/.env
```

The development stage references that project and creates the retained
`development` branch:

```sh
bunx alchemy dev --stage development --env-file apps/worker/.env
```

A `pr-<number>` stage creates a Neon branch named `preview/pr-<number>`. The
branch expires seven days after its latest deployment. Destroy the stage when
the pull request closes so its Worker and Hyperdrive are also removed:

```sh
bunx alchemy deploy --stage pr-212 --env-file apps/worker/.env
bunx alchemy destroy --stage pr-212 --env-file apps/worker/.env
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

Use `db:migrate` for a database that Alchemy does not manage. Use `db:push` only
for disposable local development. Alchemy applies committed migration files to
the production project and every child branch, so do not run both migration
systems against the same database.

The selected Twilio Verify Service must define the programmable rate-limit key
`phone_number`. Configure one bucket for one send per 30 seconds and one bucket
for five sends per hour. The Worker supplies this key on every SMS request.

### Telegram configuration

Telegram is a required onboarding and acceptance transport. Create a bot with
BotFather, then set the four `TELEGRAM_*` values shown in
`apps/worker/.env.example`. `TELEGRAM_ALLOWED_USER_IDS` is a comma-separated
list of numeric Telegram User IDs. The Worker rejects missing configuration,
users outside this list, and invalid webhook secrets.

Register this webhook URL with Telegram's `setWebhook` Bot API method:

```text
https://<development-worker>/messengers/telegram/webhook
```

Supply `TELEGRAM_WEBHOOK_SECRET_TOKEN` as the `secret_token` for that request.
The same value must arrive in Telegram's
`X-Telegram-Bot-Api-Secret-Token` header. Web-first enrollment opens the bot with
a single-use `start` token. Only the token digest is stored.

This adapter uses Think's documented manual-ingress shape. The Worker completes
allowlist, onboarding, consent, and stable Agent lookup before it submits to the
named Agent. It does not use Think's default per-thread sub-agent routing, and
Chat SDK state is not conversation authority.

Telegram `sendMessage` has no idempotency key. A `not_applied` or `prepared` delivery means that
Telegram was definitely not contacted, so its fenced lease can be taken over. Immediately before
provider contact Osfo durably changes the delivery to `ambiguous`; it never resends that event and
returns a retryable failure. A successful provider response advances the same fenced claim to
`applied`. This conservative policy can suppress one response if the Worker stops before contact,
but it cannot silently acknowledge ambiguity or duplicate a Telegram send. The User can recover
with a new Telegram event.

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
