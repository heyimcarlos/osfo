# Osfo

Osfo is a personal AI agent for non-technical users. This workspace contains the
Cloudflare Worker application, shared UI modules, a presentation-only web
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
previews these modules with local sample state. It has no transport,
authentication, persistence, synchronization, or product business logic.

Run the preview:

```sh
bun run dev
```

Product behavior will be added as focused modules inside `apps/worker`. Extract
a workspace package only after a second consumer or supported public interface
proves the seam.

The web preview requires no environment variables. The Worker uses stage-local
Cloudflare bindings declared in `apps/worker/wrangler.jsonc`.

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
