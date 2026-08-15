# HTTP application architecture comparables

Date: 2026-08-15

## Decision

Osfo should use OpenCode as its main structural reference. Use one Effect
`HttpRouter` as the Worker HTTP composition root. Better Auth and Cloudflare
execution-unit probes should remain raw routes. Osfo-owned endpoints should use
one assembled `HttpApi` made from feature groups.

The application boundary is:

```text
Cloudflare fetch
  -> HttpRouter
     -> raw Better Auth route
     -> raw Cloudflare execution-unit probes
     -> HttpApi product groups
        -> authentication middleware
        -> HTTP handler
        -> application operation
        -> request-scoped database service
        -> PostgreSQL
```

An HTTP handler owns request decoding, authentication context, response encoding,
and the mapping from application failures to public HTTP failures. An application
operation owns product rules, orchestration, and transaction boundaries. A
database module owns Drizzle queries and persistence failures. Effect Layers own
construction and lifetime.

The selected repository shape gives the wire contract a small `packages/api`
package. The Worker keeps all handlers and implementation. The web application
will consume the same contract when it calls the first protected product
endpoint.

## Comparable ranking

Each criterion is scored from 0 to 5. The criteria are domain fit, target-stack
fit, maturity, clarity, operational evidence, test evidence, and documentation.

| Rank | Repository | Domain | Stack | Maturity | Clarity | Operations | Tests | Docs | Total |
| ---- | ---------: | -----: | ----: | -------: | ------: | ---------: | ----: | ---: | ----: |
| 1    |   OpenCode |      5 |     5 |        5 |       5 |          3 |     5 |    4 | 32/35 |
| 2    |   Executor |      4 |     5 |        4 |       4 |          5 |     5 |    4 | 31/35 |
| 3    |    Grafana |      3 |     1 |        5 |       4 |          5 |     5 |    4 | 27/35 |
| 4    |     Effect |      1 |     5 |        5 |       4 |          2 |     5 |    5 | 27/35 |

Effect is the framework authority, not an application comparable. OpenCode best
matches the agent domain and desired feature division. Executor best matches the
Cloudflare, PostgreSQL, authentication, and request-lifetime constraints.

## OpenCode

OpenCode defines public groups and schemas in its protocol package, then provides
feature handler Layers from its server package. Its route composition merges
handler Layers, middleware, authentication, and application services.

```text
HttpApi group
  -> feature handler Layer
  -> request-context middleware
  -> application service
```

Useful examples:

- [Protocol group](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/protocol/src/groups/session.ts)
- [Handler group](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/server/src/handlers/session.ts)
- [Composition root](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/server/src/routes.ts)
- [Request context](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/server/src/location.ts)
- [HTTP integration test](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/opencode/test/server/httpapi-session.test.ts)

Use its separation of public contract, HTTP adaptation, and application service.
Do not create an Osfo protocol package yet. OpenCode already has independent
protocol and client consumers, while Osfo does not.

## Executor

Executor proves that `HttpApi` groups and raw routes can share one Effect
`HttpRouter`. It keeps raw routes for Better Auth, external handlers, proxies,
and other protocol surfaces that the application does not own.

Executor also proves an important Cloudflare rule: database resources need a
fresh scope and memo map for each request. The database Layer owns PostgreSQL
construction and cleanup.

Useful examples:

- [API contract](https://github.com/UsefulSoftwareCo/executor/blob/e9815289744fcd9063cf7c8e772762a17d548339/packages/core/api/src/tools/api.ts)
- [API handlers](https://github.com/UsefulSoftwareCo/executor/blob/e9815289744fcd9063cf7c8e772762a17d548339/packages/core/api/src/handlers/tools.ts)
- [Router composition](https://github.com/UsefulSoftwareCo/executor/blob/e9815289744fcd9063cf7c8e772762a17d548339/apps/cloud/src/api/router.ts)
- [Raw Better Auth composition](https://github.com/UsefulSoftwareCo/executor/blob/e9815289744fcd9063cf7c8e772762a17d548339/apps/host-selfhost/src/app.ts)
- [Request scope](https://github.com/UsefulSoftwareCo/executor/blob/e9815289744fcd9063cf7c8e772762a17d548339/packages/core/api/src/server/request-scoped.ts)
- [Request-scope regression test](https://github.com/UsefulSoftwareCo/executor/blob/e9815289744fcd9063cf7c8e772762a17d548339/apps/cloud/src/api.request-scope.node.test.ts)
- [Database Layer](https://github.com/UsefulSoftwareCo/executor/blob/e9815289744fcd9063cf7c8e772762a17d548339/apps/cloud/src/db/db.ts)

Use its mixed raw-route and typed-product-route composition, and its request
lifetime tests. Do not copy its multi-host application facade. Osfo has one host.

Executor's core product API follows the same basic pattern as OpenCode: feature
groups assemble into one API, and feature handlers assemble into one handler
Layer. Its apparent extra patterns come from separate protocol planes for
account, administration, plugins, cloud, local, and self-host use. These planes
have different authentication and host requirements. Osfo should not copy them.

`HttpApiBuilder.group(...)` is the Effect primitive that connects a named
`HttpApiGroup` contract to its implementations. It is not a second router or an
additional architectural layer.

## Grafana

Grafana provides the clearest mature example of route, application service, and
database separation. Its strongest transaction shape has an application service
open the transaction, then call the stores and other services that must commit
together.

```text
route registration
  -> authorization middleware
  -> HTTP handler
  -> application service
  -> transaction
  -> store
  -> SQL
```

Useful examples:

- [Central route tree](https://github.com/grafana/grafana/blob/59a8cbb6cd0d7a0946767fee57510ac96af8f112/pkg/api/api.go)
- [Nested route groups](https://github.com/grafana/grafana/blob/59a8cbb6cd0d7a0946767fee57510ac96af8f112/pkg/api/routing/route_register.go)
- [HTTP-facing user search](https://github.com/grafana/grafana/blob/59a8cbb6cd0d7a0946767fee57510ac96af8f112/pkg/services/searchusers/searchusers.go)
- [User service contract](https://github.com/grafana/grafana/blob/59a8cbb6cd0d7a0946767fee57510ac96af8f112/pkg/services/user/user.go)
- [User service implementation](https://github.com/grafana/grafana/blob/59a8cbb6cd0d7a0946767fee57510ac96af8f112/pkg/services/user/userimpl/user.go)
- [SQL store](https://github.com/grafana/grafana/blob/59a8cbb6cd0d7a0946767fee57510ac96af8f112/pkg/services/user/userimpl/store.go)
- [Dependency construction](https://github.com/grafana/grafana/blob/59a8cbb6cd0d7a0946767fee57510ac96af8f112/pkg/server/wire_core.go)

Use explicit dependency construction, feature-level route registration, and
service-owned transactions. Do not copy Grafana's giant central HTTP server,
an interface for every implementation, or its multi-database support.

## Effect

The official Effect HTTP API guide defines the framework model:

```text
HttpApi
  -> HttpApiGroup
  -> HttpApiEndpoint
  -> HttpApiBuilder.group handler Layer
  -> HttpRouter
```

One `HttpApi` definition can drive request validation, response encoding,
OpenAPI documentation, and a typed client. `HttpApiMiddleware.Service` can turn
request data into a typed request-scoped principal such as `CurrentUser`.

Useful sources:

- [HTTP API guide](https://github.com/Effect-TS/effect/blob/189b003a2367fa44dd4b8544aa62979f0345d179/packages/effect/HTTPAPI.md)
- [Raw router](https://github.com/Effect-TS/effect/blob/189b003a2367fa44dd4b8544aa62979f0345d179/packages/effect/src/unstable/http/HttpRouter.ts)

Use `HttpApi` for Osfo-owned product protocols. It currently lives under
Effect's unstable HTTP modules, so keep framework-specific construction inside
the protocol and Worker boundaries.

## Architecture references

The comparable repositories converge on four established principles:

1. Ports and adapters: HTTP and PostgreSQL are adapters around product behavior.
2. Application service: one use case owns orchestration and its atomic boundary.
3. Composition root: dependency construction happens in one visible outer layer.
4. Feature grouping: large route trees split by product area, not by generic
   technical categories alone.

These principles fit Effect without copying a traditional long-running server.
An Effect service represents a capability or authority with an explicit lifetime.
It is not a generic name for all code that runs after authentication.

## Selected Osfo shape

The public health contract is the first typed endpoint. Use this OpenCode-shaped
division as later product endpoints are added:

```text
packages/api/src/
  api.ts
  groups/
    health.ts
  middleware/
    auth.ts

apps/worker/src/
  app.ts
  auth.ts
  cors.ts
  handlers.ts
  routes.ts
  handlers/
    health.ts
  services/
    agent-directory.ts
    registration.ts
  db/
    index.ts
```

The assembly is deliberately symmetrical:

```text
packages/api/src/api.ts
  -> HttpApi.make("osfo")
     -> add HealthGroup
     -> add later product groups

apps/worker/src/handlers.ts
  -> HealthHandler
  -> later merge product handlers

apps/worker/src/routes.ts
  -> HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" })
     -> provide handlers
     -> later provide authentication middleware
     -> later provide application services
```

The protocol package follows OpenCode directly. `api.ts` assembles named groups,
`groups/` owns HTTP contracts, and `middleware/` owns protocol requirements.
`packages/api` owns paths, payload schemas, response schemas, public errors,
OpenAPI annotations, and middleware requirements. It does not own Better Auth,
PostgreSQL, or product behavior.

The Worker handler adapts HTTP to a deep application module:

```text
RegistrationHandler
  -> Registration.Service.complete(...)
     -> one PostgreSQL transaction
     -> durable result or typed application failure
```

The handler does not issue SQL, choose transaction boundaries, or reproduce
registration recovery rules.

Registration starts as one Effect service module, not a directory or a workspace
package. It owns a multi-row transaction, product policy, exact recovery, typed
failures, and a stable operation that will have HTTP, Registration Agent, and
reconciliation callers. Those facts earn an authority seam even while the
interface contains only `complete`.

`apps/worker/src/services/registration.ts` owns the narrow interface,
service tag, `make`, and dependency-preserving Layer. Its Layer yields the
request-scoped database once and closes over it. A future protected registration
handler will receive that Layer through `routes.ts`.

The Worker-local `services/` directory gives application capabilities the same
visible separation that OpenCode gets from its `core` package. It contains only
real Effect services, not every helper or function. Pure domain logic remains in
domain modules, database mechanics remain in `db/`, and provider adapters remain
in `integrations/`. A future `packages/core` is earned only when a second
workspace host needs the same product implementation without importing Worker
runtime details.

The Worker also does not need its own `api.ts` when `packages/api` exports one
concrete assembled `Api`. OpenCode's server `api.ts` exists because it
specializes a generic protocol factory with server-owned middleware identities.
Osfo should add that extra file only if the same need appears.

Do not create empty registration handler or concrete authentication middleware
files before a protected product endpoint needs them. The current first slice is:

```text
packages/api/src/
  api.ts
  groups/
    health.ts
  middleware/
    auth.ts

apps/worker/src/
  app.ts
  auth.ts
  cors.ts
  handlers.ts
  routes.ts
  handlers/
    health.ts
  services/
    agent-directory.ts
    registration.ts
```

`HealthGroup` is the small baseline contract. It is public and has no auth
middleware. Later protected groups attach the protocol `Auth` middleware, whose
concrete Better Auth implementation remains in the Worker.

## Testing shape

- Test application operations directly with controlled service Layers.
- Test handler groups through `HttpApiTest` or a real Effect test server.
- Test the complete Worker route tree with real HTTP requests.
- Keep a regression test for sequential and concurrent request-scoped database
  lifetime.
- Verify that HTTP handlers do not start product transactions or issue SQL.

## Sources and access date

All repositories were inspected locally on 2026-08-15 after updating the
reference checkout where required.

- Effect commit `189b003a2367fa44dd4b8544aa62979f0345d179`
- Executor commit `e9815289744fcd9063cf7c8e772762a17d548339`
- OpenCode commit `4643e65ad6334de3e4e68dedc201d5fbb828c9fe`
- Grafana commit `59a8cbb6cd0d7a0946767fee57510ac96af8f112`
