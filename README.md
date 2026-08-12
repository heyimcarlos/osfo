# Osfo

Osfo is the product workspace for Oz, a personal AI agent. The repository is at
a clean foundation stage. It contains the shared UI package, a presentation-only
web preview, and the accepted product and architecture decisions. It does not
contain a deployable Oz application yet.

## Product direction

- [CONTEXT.md](CONTEXT.md) defines the domain language.
- [The Oz v1 specification](docs/specs/oz-v1.md) defines the launch product and
  target architecture.
- [Current ADRs](docs/adr/) record accepted Cloudflare, Think, and storage
  decisions.
- [The implementation map](https://github.com/heyimcarlos/osfo/issues/167)
  owns active work.

## Current workspace

The @osfo/ui package contains shared React DOM, Tailwind CSS, shadcn/ui
presentation components, and the controlled chat interface. The @osfo/web
application previews these components with local sample state. It has no
transport, authentication, persistence, synchronization, or product business
logic.

Run the preview:

```sh
bun run dev
```

Product applications and runtime packages will be added as vertical slices from
the implementation map.

The current baseline requires no environment variables.

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
