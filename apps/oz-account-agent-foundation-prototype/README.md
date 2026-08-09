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
from reaching the Cloudflare API. It also supplies the local bearer token used
by the TUI. Every route except `/health` requires that token.

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

The local restart action terminates `workerd` during an active slow turn and
recreates it. A changed activation ID, one completed recovered submission, one
copy of its durable Session message, and retained receipts and reminders
demonstrate local cold-activation and in-flight turn recovery. Think owns turn
serialization, idempotency, cancellation, recovery, Session storage, and alarm
multiplexing. Oz does not create parallel execution states for those concerns.

## Live Cloudflare checkpoint

Local `workerd` cannot deterministically force Cloudflare's production eviction
or placement behavior. After authenticating Wrangler, run:

```sh
export OZ_PROTOTYPE_TOKEN="replace-with-a-random-secret"
ALCHEMY_STAGE=live bun run --cwd apps/oz-account-agent-foundation-prototype alchemy deploy --stage live
```

Then drive the same HTTP routes against the exported URL and repeat the process
restart and idle wake observations, sending `Authorization: Bearer
$OZ_PROTOTYPE_TOKEN` on every non-health request. A live deploy is required
before claiming production hibernation, regional placement, or Alchemy
resource recovery as passing evidence.

The `live` stage uses Alchemy's Cloudflare-backed state store; other stages keep
throwaway state locally. The ticket's live observation pass completed on
2026-08-09. Alchemy created the Worker, D1 database, secret binding, and
account-agent Durable Object namespace.
The authenticated route journey proved direct submission, immutable acceptance
receipts, idempotent retry, cancellation, and alarm delivery. Cloudflare then
reactivated the same named Durable Object with a new activation ID while its
Session messages and submission ledger remained durable. The live deployment
remains available for human inspection; the local command does not rerun or
claim that nondeterministic production observation.
