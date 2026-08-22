---
status: accepted
---

# Organize tests by owned module and composed journey

Osfo will get most of its behavioral confidence by driving the composed Cloudflare
Worker through its public interfaces against real PostgreSQL. Tests that belong to
one module stay beside that module. Journeys that cross modules stay in the owning
application's `test/` directory. Test support does not enter the production import
graph, and production modules do not gain test-only behavior.

This replaces the ticket-by-ticket testing direction in
[`docs/specs/osfo-v1.md`](../specs/osfo-v1.md). That specification is evidence about
the intended product, not an immutable test inventory. A later product decision may
improve, replace, or retire one of its claims. Tests follow the current product model
and module ownership rather than preserving an obsolete requirement for parity.

A ticket may add or change a test, but no test file, fixture, database, route,
binding, or Action is named after the ticket.

## Test shape

The primary Worker tests boot the real application in workerd and call its public
HTTP, scheduled, or webhook interface. They use:

- a migrated PostgreSQL database cloned from a template for each test file;
- the same injected database identity in the Worker and every Durable Object;
- real Better Auth policy and User Registration flows;
- real Osfo modules and provider adapters;
- local HTTP emulators only for services outside Osfo;
- request ledgers exposed by those emulators; and
- assertions on the response, committed Osfo state, and relevant provider ledger.

Fresh Users and other domain identities isolate tests within a file. A test that
needs stronger isolation may request a database clone for each test. Transaction
rollback is not an isolation mechanism because the composed application commits
through its own connections.

There are no automatic retries. A bounded condition wait may observe asynchronous
work, but sleeps and retries must not hide flakes. Scheduled behavior is exercised
through the Worker's scheduled interface rather than a production-only timer hook.

## Code placement

Tests with one clear module owner are colocated with that module and mirror its
name:

```text
apps/worker/src/billing/checkout.ts
apps/worker/src/billing/checkout.test.ts

apps/worker/src/integrations/twilio/verify.ts
apps/worker/src/integrations/twilio/verify.test.ts
```

This includes pure behavior tests and the deliberate minority of module tests that
replace an internal adapter or use a local database. Runtime-specific suffixes such
as `.node.test.ts` are allowed when the runtime changes what the test can prove.

Tests that exercise the composed Worker belong to the application rather than one
source module:

```text
apps/worker/test/
  journeys/       # User Registration, billing, messaging, and other product flows
  contracts/      # wire shapes and reusable adapter conformance
  postgres/       # PostgreSQL concurrency and migration evidence
  support/        # spawnApp, AuthDriver, environment assembly, and cleanup
  emulators/      # provider HTTP servers, scenarios, and request ledgers
  meta/           # test and CI convention checks
```

`spawnApp()` remains in `apps/worker/test/support`. Osfo will not publish an
`@osfo/worker/testing` entrypoint until a second consumer needs a stable Worker test
interface. A repository-root `e2e/` directory is also deferred until one suite
genuinely crosses applications or runs a built production artifact. Executor needs
that directory because it drives cloud, self-hosted, desktop, and CLI targets. Osfo
currently has one Worker composition target.

`packages/db` continues to own reusable PostgreSQL test support. It exposes the
narrow `@osfo/db/testing/postgres` entrypoint backed by files under
`packages/db/test/` so other workspace packages do not cross its package boundary
with relative imports. That entrypoint is test-only and is never imported by
production modules.

Colocation does not place tests in the Worker bundle. Wrangler starts from the
production entrypoint and includes only imported modules. Test files, Vitest,
emulators, ledgers, database controls, fixture builders, and test credentials must
remain outside the production import graph.

## Production seams

Tests may use a production interface when the interface represents real deployment
variation. Provider origins are valid configuration because the same adapter may
talk to a provider directly, through a proxy, or through a local emulator. The
production default remains the provider's real origin.

This rule permits bindings such as `TWILIO_VERIFY_API_BASE_URL`. It does not permit
test mode flags, test-only routes, test-only Durable Object bindings, hidden test
actions, mutable clocks, production exports of internals, or branches that change
product behavior only during tests. Existing examples of those patterns are
migration debt and will be removed after replacement evidence exists.

An interface is not introduced merely because a test could replace it. Production
and test adapters justify a seam only when the dependency actually varies, as it
does for a true external provider. Tests of Osfo-owned behavior use the real module
through its ordinary interface.

## Provider emulation

S0 probes established that no fetch interception mechanism satisfies Osfo's
runtime:

| Mechanism                   | PostgreSQL over TCP | Worker fetch     | Durable Object fetch |
| --------------------------- | ------------------- | ---------------- | -------------------- |
| Miniflare `outboundService` | workerd crashes     | intercepted      | intercepted          |
| `@msw/cloudflare`           | works               | intercepted      | escapes its isolate  |
| local HTTP emulators        | works               | reaches emulator | reaches emulator     |

Osfo therefore uses local HTTP emulators at configured provider origins. Better
Auth itself is not emulated because it is Osfo's in-process authentication policy
over the same PostgreSQL database. Its hosted dashboard API is an external provider
and is emulated. CI gives the journeys PostgreSQL and emulator origins, but no live
provider credentials. Configuration tests prove that each external adapter used by
the current journeys honors its configured origin.

Scripted emulator responses come first. Recorded and redacted cassettes may be
added later for provider flows where hand-written responses no longer give enough
wire fidelity. Missing recordings fail in CI, and CI never records with live
credentials.

## Test tiers

1. Colocated module tests cover pure rules and focused module behavior.
2. Composed Worker journeys are the primary behavioral tier and run on every pull
   request with real PostgreSQL.
3. Contract and conformance tests protect wire shapes and shared adapter behavior.
4. Focused whitebox tests remain only when a public journey cannot observe the
   invariant. Each such test states why it needs internal access.
5. Built-artifact smoke tests remain a later release gate, not a substitute for
   composed journeys.

## Browser evidence

Playwright belongs in a separate browser tier when a journey drives the rendered
`apps/web` application against a real Worker. It does not belong in composed
Worker journeys that have no browser to observe. User Registration and billing
are the first browser candidates after their Worker journeys are stable.

Each browser journey must use assertions on visible state and public outcomes as
its pass or fail criteria. It also records reviewer evidence:

- one named step for each user action;
- a screenshot after each step and a final failure screenshot;
- a Playwright trace with screenshots, DOM snapshots, and sources; and
- a fixed-size session video.

CI retains the trace, video, and screenshots for failed runs. Release evidence may
retain successful runs when a product requirement calls for review. These files
help a reviewer reconstruct what happened, but they never replace assertions or
database and provider evidence.

The old corpus is not a migration checklist. Tests that encode ticket sequencing,
internal topology, or test-only product behavior are deleted without recreating
them. Replacement coverage is selected from current product contracts, operational
risk, and User-visible journeys. If behavior still matters but lacks sound evidence,
the project records it as MISSING until a stable test exists.

Manual file lists, the `osfo_ticket_170` database, test-only production code,
prototype spies, global fetch spies, and direct Durable Object storage access have
no place in the final structure.

## Consequences

The suite costs more to start than isolated unit tests because it boots workerd,
clones PostgreSQL, and starts provider emulators. In return it exercises middleware,
authentication, transactions, Durable Object composition, provider request bytes,
and deployment configuration together. Colocated module tests keep fast feedback
and ownership clear, while application journeys keep multi-module behavior from
being scattered across source directories.

The design deliberately accepts a small amount of production configuration for
external origins. It rejects production behavior whose only caller is a test.
