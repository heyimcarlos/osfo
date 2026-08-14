# ADR 0005: Use PostgreSQL and Better Auth for the control plane

Date: 2026-08-13

Status: Accepted

Osfo v1 uses one Neon PostgreSQL database for shared control-plane facts. The
Worker connects through Cloudflare Hyperdrive. The private `@osfo/db` package
owns the Drizzle schema, client construction, and one forward-only migration
chain in `packages/db`.

Better Auth owns authentication in that same schema. Its `users` table is the
Osfo control-plane User table. Osfo does not create a second product `users`
table. Better Auth also owns `sessions`, `accounts`, `verifications`, and
`rate_limits`. Osfo product tables reference `users.id`, which is the stable
UserId. The Better Auth phone-number plugin is the selected SMS authentication
path. Twilio Verify will send and verify codes when runtime authentication is
implemented. The private `@osfo/auth` package owns this Better Auth policy and
accepts a request-scoped Drizzle database. The Worker owns the Hyperdrive
connection, runtime configuration, Twilio adapter, and HTTP route.
Better Auth Dashboard access uses the `dash` plugin and a Worker-supplied,
redacted API key. Dashboard activity tracking is disabled, so it adds no local
audit or activity table. Email-and-password authentication is enabled only as a
temporary development entrypoint and is not part of the v1 launch contract.

The control-plane schema also owns Agent routing, Subscription, and allowance
period facts. It does not own private Session content,
memory, or Agent-local execution facts. Each User-scoped Agent keeps those facts
in its Durable Object SQLite database. R2 remains the large immutable content
store. There is no transaction across PostgreSQL, Agent SQLite, R2, Workflows,
or an external provider.

This choice improves schema and transaction support for the shared control
plane and uses the team's existing PostgreSQL knowledge. It adds Neon and
Hyperdrive as operated dependencies. Disabling Hyperdrive query caching keeps
authorization and registration reads consistent with current writes.
