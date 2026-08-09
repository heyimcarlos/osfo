# Oz account-agent foundation prototype

PROTOTYPE ONLY. This lab answers one question: can Cloudflare Think, one named
account-scoped Durable Object, Alchemy, Effect, Drizzle D1 and Durable Object
SQLite, and Agent alarms jointly own Oz's first execution path without a second
Oz runtime or queue state machine?

## Run

From the repository root:

```sh
bun run --cwd apps/oz-account-agent-foundation-prototype prototype
```

Press `x` to drive the complete local acceptance journey, or use each shortcut
individually. The TUI prints the complete relevant durable state after every
action.

The runner supplies syntactically valid dummy Cloudflare credentials only to
let Alchemy plan locally. Local state and local providers prevent those values
from reaching the Cloudflare API.

For an automatic local observation pass:

```sh
bun run --cwd apps/oz-account-agent-foundation-prototype prototype:probe
```

## What the lab makes concrete

```text
HTTP message
  -> D1 Channel Binding lookup
  -> named AccountAgent Durable Object
  -> Think submitMessages durable receipt
  -> Think Session and submission ledger in DO SQLite
  -> one AccountAgentRuntime.run Promise-to-Effect adapter
  -> Effect-owned D1 activation audit and Drizzle DO receipt ledger
  -> Think alarm callback for a background reminder
```

The account-agent boundary explicitly initializes Think before each custom
Durable Object RPC. Cloudflare's own internal RPC entrypoints use the same
guard because RPC bypasses the normal HTTP initialization path.

The local restart action terminates and recreates `workerd`. A changed
activation ID with durable Session history, receipts, submissions, and
reminders demonstrates local cold-activation recovery. Think owns turn serialization,
idempotency, cancellation, recovery, Session storage, and alarm multiplexing.
Oz does not create parallel execution states for those concerns.

## Live Cloudflare checkpoint

Local `workerd` cannot deterministically force Cloudflare's production eviction
or placement behavior. After authenticating Wrangler, run:

```sh
bun run --cwd apps/oz-account-agent-foundation-prototype alchemy deploy
```

Then drive the same HTTP routes against the exported URL and repeat the process
restart and idle wake observations. A live deploy is required before claiming
production hibernation, regional placement, or Alchemy resource recovery as
passing evidence.
