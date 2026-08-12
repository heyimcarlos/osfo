# ADR 0002: Separate Osfo semantics from Agent Applications and Adapters

Date: 2026-08-07

Status: Superseded for Oz v1 by ADRs 0003 and 0004

## Context

Osfo must support long-lived agent products without making one product, model
provider, transport, tool catalog, or deployment configuration part of its
reusable domain. Oz must also remain a real deployed application rather than a
temporary demonstration harness.

The model-provider boundary is especially important. A provider protocol can
stream observations, fail ambiguously, report usage, and support cancellation,
but it must not own AgentRun lifecycle, durable retries, canonical Thread state,
or product policy. Likewise, an in-memory agent loop cannot become recovery
authority after worker or deployment loss.

Executor demonstrates explicit application composition over narrow provider
seams. OpenCode demonstrates one provider-neutral model turn beneath an
enclosing agent loop. Restate demonstrates commit-before-effect, fencing,
reconstruction, and retained idempotent outcomes. None provides Osfo's exact
Thread and AgentRun contracts.

## Decision

Osfo owns reusable agent semantics and authority boundaries. An Agent
Application selects and constrains concrete implementations. Oz is the initial
Reference Agent Application.

The Agent Runtime is authority-free. It examines reconstructed recorded
AgentRun state and proposes one typed next step. It does not call providers,
execute tools, write PostgreSQL, append ThreadEvents, schedule work, or own
credentials.

The durable AgentRun driver is the sole lifecycle owner. For each step it
validates the current fence, commits logical intent, invokes one scoped
executor, commits normalized observations and outcome, then reconstructs the
state supplied to the Runtime. Process memory is disposable.

`ModelCallExecutor` is the Osfo-owned Model Adapter interface. A Model Adapter
translates one committed ModelCallAttempt into one provider protocol operation
and normalizes observations, dispatch evidence, usage, cancellation, and
outcome. It does not select product policy or own durable logical retries.

Oz owns concrete Execution Profiles, selected Model Adapters, prompts, tool and
Action definitions, workflow definitions, authorization policy, credentials,
identity composition, UI, and deployment inputs. OpenRouter is one possible Oz
Model Adapter, not an Osfo runtime dependency and not the identity of Oz.

Packages expose capability-specific interfaces. Application composition roots
provide Effect Layers. Adapters receive scoped capabilities rather than raw
database clients or deployment credentials. A new reusable package or public
Adapter abstraction is earned only by substantial hidden behavior, multiple
real consumers, a security or deployment authority, or demonstrated provider
variation.

## Consequences

- Osfo remains reusable across products and provider choices.
- Oz can change Model Adapters without changing AgentRun or Thread authority.
- Provider, tool, workflow, and transport types cannot enter canonical durable
  records unless normalized into Osfo-owned versioned values.
- Deterministic executors remain conformance fixtures and cannot qualify a live
  provider.
- Every production Adapter needs a provider-independent conformance suite and
  focused live integration evidence.
- Ordinary ToolCalls and externally effectful Actions retain separate execution
  and retry contracts.
- Recovery reconstructs from recorded interactions and a pinned Execution
  Profile. It never continues from an in-memory agent object.
- Oz application composition becomes an explicit implementation surface rather
  than implicit wiring scattered across reusable packages.

For Oz v1, ADR 0003 replaces the hand-built Agent Runtime and AgentRun driver
with Think. ADR 0004 makes Think the sole Thread and turn authority. This ADR's
separation of product policy from external provider adapters remains an accepted
design invariant. Its AgentRun and PostgreSQL implementation is historical.
