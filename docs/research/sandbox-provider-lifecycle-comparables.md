# Sandbox Provider Lifecycle Comparables

All web and repository sources in this report were accessed on 2026-08-05.
E2B pages were selected from E2B's first-party
[documentation index](https://e2b.dev/llms.txt) and checked against the
[first-party source repository](https://github.com/e2b-dev/e2b).

## Decision frame

- **Target project:** Osfo, whose production stack is TypeScript with Effect 4
  on Node 24 and whose workers are expected to run on Google Cloud Run. The
  local repository still contains the earlier Rust scaffold and no sandbox
  implementation ([`Cargo.toml`](../../Cargo.toml)).
- **Settled provider choice:** Osfo v1 integrates E2B directly through its
  official SDK. It defines no provider abstraction before a second provider
  creates real variation.
- **Question left to resolve:** Which E2B behavior belongs in Osfo's stable,
  provider-independent invariants, and which behavior remains concrete E2B
  operational state?
- **Hard constraints:** One disposable sandbox is owned by one RunCode ToolCall.
  V1 creates, executes, exports, and kills without SandboxRef restoration or
  workspace reuse. Authoritative outputs become ArtifactRefs only after export
  and verification. A future persistent or self-hosted integration is justified
  only by a concrete journey or measured production need.

## Ranked comparables

| Rank | Comparable | Domain | TypeScript fit | Maturity | Architecture | Operations | Testing | Docs | Total |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | E2B hosted sandbox platform | 5 | 5 | 4 | 4 | 5 | 4 | 5 | **32/35** |
| 2 | OpenAI Agents SDK sandbox clients | 5 | 3 | 3 | 5 | 4 | 5 | 5 | **30/35** |
| 3 | Effective AI multi-agent runtime | 5 | 2 | 3 | 3 | 5 | 1 | 3 | **22/35** |

E2B is the strongest overall comparable and the selected production provider,
but its provider-native API cannot be copied directly into the Osfo contract.
The OpenAI SDK is the best interface comparable because it separates client,
session state, snapshot, lifecycle, and artifact materialization. It is still a
beta Python implementation, not an Osfo dependency. Effective AI is a strong
lifecycle comparable, but its runtime is
proprietary and its public article does not expose conformance tests or recovery
code. These assessments are supported by the
[OpenAI sandbox guide](https://openai.github.io/openai-agents-python/sandbox/guide/),
[OpenAI client guide](https://openai.github.io/openai-agents-python/sandbox/clients/),
[E2B repository](https://github.com/e2b-dev/E2B), and
[Effective AI's runtime article](https://effectiveailabs.com/blog/multi-agent-runtime).

## E2B lifecycle facts

### Reconnect, pause, and resume are distinct

`Sandbox.connect(id)` reattaches to a running sandbox or resumes the same paused
sandbox identity. A full pause preserves the filesystem, memory, running
processes, and loaded state. Pause disconnects external clients, so command
streams, PTYs, services, and other network clients must reconnect after resume.
E2B documents pause at roughly four seconds per GiB of RAM and resume at roughly
one second. Paused retention is documented as indefinite, but that provider
retention promise is not a valid Osfo recovery invariant
([E2B persistence](https://e2b.dev/docs/sandbox/persistence)).

A provider connection is therefore disposable. Osfo may persist an opaque
SandboxRef, then ask the E2B module to reconnect. `Missing`, `incompatible`, or
uncertain reconnect results must fall back to cold reconstruction or classified
AgentRun recovery. A socket, SDK object, sandbox ID, or E2B retention policy is
never durable authority.

### Timeout is an inactivity lifecycle control, not AgentRun time

E2B's default sandbox timeout is five minutes. Connecting resets the timeout,
and callers may replace it with `setTimeout`. The default timeout action kills
the sandbox. Configuring `onTimeout: "pause"` instead enables auto-pause.
`autoResume: true` lets a later SDK file or command operation, or tunneled HTTP
request, wake a full-memory paused sandbox. After auto-resume the timeout is at
least five minutes, or the original longer value
([E2B sandbox lifecycle](https://e2b.dev/docs/sandbox),
[E2B auto-resume](https://e2b.dev/docs/sandbox/auto-resume)).

E2B also applies plan-dependent continuous-running limits, reset by
pause/resume. These controls are provider scheduling and billing facts. They do
not define AgentRun waiting, deadlines, cancellation, retry, or lease validity
([E2B persistence limits](https://e2b.dev/docs/sandbox/persistence)).

### Pause/resume and snapshot/template have different identities

Pause/resume is one-to-one and preserves the same sandbox identity. A runtime
snapshot is one-to-many: it briefly pauses a running sandbox, drops active
connections, then lets the original continue while the snapshot can create new
sandbox identities. Snapshots capture filesystem and memory but expose a
provider snapshot ID, not a portable, checksummed Osfo artifact
([E2B snapshots](https://e2b.dev/docs/sandbox/snapshots)). A filesystem-only
pause preserves disk but discards memory and processes, then reboots on resume
([E2B filesystem-only snapshots](https://e2b.dev/docs/sandbox/filesystem-only-snapshots)).

Templates are declarative base environments. They can set the base image,
environment, files, build commands, and a start/readiness command captured with
its running process
([E2B template quickstart](https://e2b.dev/docs/template/quickstart)). Template
tags are movable. E2B explicitly supports creating from an exact `build_id`, so
Osfo compatibility must pin that exact build artifact and never depend on a
moving `default`, `latest`, or `production` tag
([E2B template versioning](https://e2b.dev/docs/template/tags)).

The stable vocabulary should consequently remain:

```text
SandboxProfileV1  exact required environment and policy
SandboxRef        opaque same-environment reconnect acceleration
provider snapshot optional replacement/fork acceleration
ArtifactRef       immutable Osfo-owned authoritative content
```

Provider snapshot IDs and sandbox IDs stay inside the encrypted SandboxRef
payload. The SandboxProfile compatibility identity records the E2B SDK version
and exact template build identity without exposing E2B's public API shape to
AgentRun code.

## E2B execution, security, and export facts

E2B supports foreground and background commands, environment variables,
working directory, user, stdin, output callbacks, PID listing, reconnection to a
running command, and SIGKILL. Its JavaScript API accepts one shell string, not a
program plus argument vector
([E2B command source](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/index.ts),
[E2B command-handle source](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/commandHandle.ts)).
The E2B module must preserve Osfo's structured program and arguments contract
by correct quoting or a fixed in-sandbox launcher. Shell parsing must not leak
into AgentRun orchestration.

The public E2B surface does not document hard per-command CPU, memory, disk,
process-count, or output-byte limits. CPU and memory are selected for a template
build, while disk capacity is plan-derived rather than a per-sandbox create
parameter
([E2B template build](https://e2b.dev/docs/template/build),
[E2B billing and limits](https://e2b.dev/docs/billing)). E2B command timeout is
not documented as proof that the underlying process was killed. Osfo must bound
captured output itself and implement hard command expiry as background start,
explicit process kill, and post-kill verification. A production profile is
certified only if retained conformance evidence demonstrates its process, disk,
and resource bounds. Unsupported bounds fail profile validation, they are never
silently weakened.

Outbound internet is enabled by default. E2B can disable it or apply IP, CIDR,
and domain allow rules, but domain filtering has documented port and protocol
limits. Osfo must always send an explicit deny-by-default network policy rather
than inherit provider defaults
([E2B internet access](https://e2b.dev/docs/network/internet-access)). Public
sandbox URLs are open by default unless `allowPublicTraffic` is disabled and a
per-sandbox traffic token is required
([E2B restricted public access](https://e2b.dev/docs/network/restrict-public-access)).

The E2B control credential is `E2B_API_KEY`. SDK-to-controller secure access is
enabled by default in SDK v2 and uses a returned access token
([E2B API keys](https://e2b.dev/docs/api-key),
[E2B secured access](https://e2b.dev/docs/sandbox/secured-access)). Neither
credential belongs inside the sandbox. Workload credentials may be scoped to a
command, but E2B states that command environment variables are not private from
the sandbox OS. Full pause and snapshot also preserve memory and filesystem
state. Osfo should therefore issue least-privilege, short-lived workload
credentials and assume all code in that AgentRun's sandbox can read them
([E2B environment variables](https://e2b.dev/docs/sandbox/environment-variables)).

E2B can return file bytes through `files.read()` or a presigned download URL.
That is export transport only. It does not create an Osfo artifact, establish a
content digest, or atomically commit an outcome
([E2B file download](https://e2b.dev/docs/filesystem/download)). The required
artifact path is:

```text
declared sandbox output path
  -> bounded export stream from E2B
  -> Osfo-owned object storage upload
  -> digest, byte length, media type, and interpretation verification
  -> immutable ClientContentRefV1
  -> ArtifactRef committed with the semantic outcome
  -> sandbox cleanup
```

An E2B path, presigned URL, sandbox ID, or snapshot ID is never an authoritative
artifact reference. Failed or uncertain export leaves no committed ArtifactRef
and must be safely retryable by content identity.

## Comparable implementation shapes

### E2B

The relevant first-party code is concentrated in:

- [`packages/js-sdk/src/sandbox/index.ts`](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/index.ts), lifecycle and the composed command/filesystem clients.
- [`packages/js-sdk/src/sandbox/commands/index.ts`](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/index.ts), command start and reconnect behavior.
- [`packages/js-sdk/src/sandbox/filesystem/index.ts`](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/filesystem/index.ts), file transfer.
- [`packages/js-sdk/src/sandbox/network.ts`](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/network.ts), network rules.
- [`spec/openapi.yml`](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/spec/openapi.yml), provider control-plane schema.
- [`packages/js-sdk/tests/sandbox`](https://github.com/e2b-dev/E2B/tree/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/tests/sandbox), SDK lifecycle and failure tests.

E2B officially directs users to JavaScript/TypeScript or Python clients
([E2B README](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/README.md)). Osfo may implement a
thin Effect wrapper around E2B's JavaScript client, while the SDK version and
provider transport remain private implementation details.

### OpenAI Agents SDK

The OpenAI Agents SDK now has a provider-neutral `BaseSandboxClient` with
`create`, `resume`, `delete`, and serializable session state. It separates
reconnecting one provider session from seeding a fresh session with a snapshot,
and separates SDK-owned from developer-owned cleanup
([OpenAI sandbox client source](https://github.com/openai/openai-agents-python/blob/005a752dfc372733d28da997cb0d6195ee0229eb/src/agents/sandbox/session/sandbox_client.py),
[OpenAI lifecycle guide](https://openai.github.io/openai-agents-python/sandbox/guide/)).

Its current client set includes Unix-local, Docker, E2B, and several other
hosted providers. This corrects the narrower assumption that the Agents SDK
only uses its own Docker sandbox
([OpenAI client guide](https://openai.github.io/openai-agents-python/sandbox/clients/)).
The E2B extension translates shell arguments, lifecycle, provider errors,
workspace persistence, and pause-on-exit behind one client
([`src/agents/extensions/sandbox/e2b/sandbox.py`](https://github.com/openai/openai-agents-python/blob/005a752dfc372733d28da997cb0d6195ee0229eb/src/agents/extensions/sandbox/e2b/sandbox.py)).
Its fake-backed E2B tests are strong evidence for injecting and mocking the E2B
client in Osfo tests without inventing a second provider implementation
([`tests/extensions/sandbox/test_e2b.py`](https://github.com/openai/openai-agents-python/blob/005a752dfc372733d28da997cb0d6195ee0229eb/tests/extensions/sandbox/test_e2b.py)).

The feature is explicitly beta and implemented in Python, so Osfo should copy
the seam and test ideas, not its public types or runtime ownership model
([OpenAI client guide](https://openai.github.io/openai-agents-python/sandbox/clients/)).

### Effective AI

The intended comparable is Effective AI, not a project named "Effect AI".
Effective AI reports that its parent agent cooperatively yields, its LLM loop
stops, and its E2B sandbox may then pause. A durable completion pipeline wakes
the parent, resumes E2B first, resolves an application Promise, and injects the
result. The same article describes shared and isolated child compute
([Effective AI multi-agent runtime](https://effectiveailabs.com/blog/multi-agent-runtime)).

This is evidence for the cost and correctness value of pause during durable
waits. It is not evidence that E2B supplies yielding, durable events, wakeups,
claims, retries, or notification coalescing. Effective AI says those are runtime
mechanisms it built around E2B. Its shared child compute also conflicts with
Osfo's accepted one-sandbox-per-AgentRun ownership rule, so that part should not
be copied.

Effective AI publishes no production runtime repository or E2B integration source.
Its public GitHub organization contains forks of E2B and code-interpreter, but
no inspectable implementation of the runtime described in the article
([Effective AI repositories](https://github.com/orgs/effectiveailabs/repositories),
[Effective AI E2B fork](https://github.com/effectiveailabs/E2B)). The article is
therefore a first-party operational design account, not source-level evidence
for recovery or security behavior.

## Cloud Run deployment fit

Cloud Run cannot grant privileged containers, add kernel capabilities,
manipulate devices, or provide Docker's `--privileged` equivalent. Its
containers run inside Linux namespaces and lack write access to much of
`/dev`, `/proc`, and `/sys`
([Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract)).
This makes a conventional nested Docker daemon a poor production sandbox
boundary inside the Osfo worker. It does not prove every rootless or user-space
isolation technique impossible, but any such design would need a separate
security and conformance case.

Cloud Run sidecars share the instance network namespace and may share an
in-memory volume, so a sidecar is deployment composition, not a tenant sandbox
boundary
([Cloud Run multi-container services](https://docs.cloud.google.com/run/docs/deploying#sidecars)).
By contrast, Cloud Run supports outbound internet access to external APIs, with
VPC routing controls when needed, which fits an E2B control-plane client
([Cloud Run VPC egress](https://docs.cloud.google.com/run/docs/configuring/vpc-connectors)).

Cloud Run service requests default to five minutes and can be configured up to
60 minutes. Google recommends resumable, idempotent handling for longer
requests because reconnects are not guaranteed to reach the same instance
([Cloud Run request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)).
This reinforces the accepted Osfo design: Cloud Run workers and connections are
disposable, while AgentRun recovery and E2B SandboxRef handling are durable and
instance-independent.

## Stable Osfo invariants versus private E2B facts

| Osfo invariant around the concrete module | Private E2B operational fact |
|---|---|
| Use one exact immutable Sandbox Profile | E2B project, template name, exact build ID, SDK/API protocol |
| Persist no SandboxRef in the disposable v1 slice | Sandbox ID, access tokens, traffic token, snapshot ID |
| Classify uncertain create, command, export, and kill observations | Timeout behavior, stream state, SDK exception |
| Accept structured program and arguments from orchestration | E2B shell string, PID, stream, PTY, and quoting details |
| Fence semantic commits from stale attempts | E2B SIGKILL calls and post-kill polling |
| Kill after outcome or terminal failure and reconcile uncertainty | E2B kill and provider retention behavior |
| Apply explicit immutable network and credential policy | E2B rule syntax, public URL behavior, domain-filter quirks |
| Verify exported bytes before committing an ArtifactRef | `files.read`, presigned URLs, controller transport |
| Reconcile cleanup until killed or missing | E2B `kill` calls and provider cleanup retries |

`yield`, pause, resume, connect, snapshots, and workspace reuse are outside the
first v1 slice. AgentRun waits and ChildJoin remain entirely PostgreSQL-owned.

## Recommended local shape

Keep one deep concrete module around the official SDK:

```text
sandbox/e2b.ts
  E2B create, command, file export, and kill operations
  Osfo claim checks, lifecycle ledger, export verification, and cleanup

sandbox/e2b.test.ts
  mocked E2B client, fault injection, and retained conformance cases
```

Do not implement `SandboxProvider`, `E2bSandboxAdapter`, or a deterministic fake
provider in v1. Tests replace the E2B client at the module's internal seam and
exercise missing references, uncertain operations, late output, fencing,
resource exhaustion, corrupted exports, cancellation races, and cleanup.

A local or self-hosted production integration remains deferred. Production
evidence justifies opening that continuation only if E2B repeatedly misses a
required SLO or cost target, cannot certify an isolation, residency, network,
or resource invariant, creates unacceptable provider concentration risk, or
SDK maintenance becomes material. If that happens, compare its concrete
behavior with E2B and extract only the interface both implementations earn.

## Final recommendation

Use the official E2B SDK directly through one concrete deep module for an
on-demand RunCode ToolCall: create, stage immutable inputs, run bounded work,
export verified content, commit the outcome, and kill. Keep E2B IDs, timeouts,
snapshots, connections, shell strings, URLs, tokens, quotas, and plan limits
private. Test with a mocked E2B client and fault injection. Add persistence only
after a concrete journey proves it, and add a provider abstraction only when a
second real provider creates actual variation.

## Sources

All sources below were accessed on 2026-08-05.

- [E2B documentation index](https://e2b.dev/llms.txt)
- [E2B repository at reviewed commit](https://github.com/e2b-dev/E2B/tree/998e560a1abb85f0e5d2c6346b5c033f81f17736)
- [E2B sandbox lifecycle](https://e2b.dev/docs/sandbox)
- [E2B persistence](https://e2b.dev/docs/sandbox/persistence)
- [E2B auto-resume](https://e2b.dev/docs/sandbox/auto-resume)
- [E2B snapshots](https://e2b.dev/docs/sandbox/snapshots)
- [E2B filesystem-only snapshots](https://e2b.dev/docs/sandbox/filesystem-only-snapshots)
- [E2B template quickstart](https://e2b.dev/docs/template/quickstart)
- [E2B template versioning](https://e2b.dev/docs/template/tags)
- [E2B template build](https://e2b.dev/docs/template/build)
- [E2B internet access](https://e2b.dev/docs/network/internet-access)
- [E2B restricted public access](https://e2b.dev/docs/network/restrict-public-access)
- [E2B secured access](https://e2b.dev/docs/sandbox/secured-access)
- [E2B environment variables](https://e2b.dev/docs/sandbox/environment-variables)
- [E2B file download](https://e2b.dev/docs/filesystem/download)
- [OpenAI Agents SDK at reviewed commit](https://github.com/openai/openai-agents-python/tree/005a752dfc372733d28da997cb0d6195ee0229eb)
- [OpenAI sandbox guide](https://openai.github.io/openai-agents-python/sandbox/guide/)
- [OpenAI sandbox clients](https://openai.github.io/openai-agents-python/sandbox/clients/)
- [Effective AI multi-agent runtime](https://effectiveailabs.com/blog/multi-agent-runtime)
- [Google Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract)
- [Google Cloud Run request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)
- [Google Cloud Run multi-container services](https://docs.cloud.google.com/run/docs/deploying#sidecars)
- [Google Cloud Run VPC egress](https://docs.cloud.google.com/run/docs/configuring/vpc-connectors)
