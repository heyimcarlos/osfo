# E2B Sandbox Network and Credential Policy

All web and repository sources in this note were accessed on 2026-08-05.
This resolves one decision for
[Define the Sandbox Provider and artifact-export contract](https://github.com/heyimcarlos/osfo/issues/54):
the v1 network, inbound-access, and credential policy for Osfo's concrete E2B
sandbox module. V1 uses the official E2B SDK directly. It does not define a
provider-neutral Adapter seam.

## Accepted authority constraints

- One disposable Sandbox belongs to one RunCode ToolCall. PostgreSQL claim
  epochs, not E2B sessions, authorize execution and commits. V1 never pauses,
  reconnects, snapshots, or reuses that Sandbox.
- A Sandbox Profile is immutable and pinned by the AgentRun. Runtime code does
  not negotiate or broaden it.
- A classified external effect is one exact committed Action. Its Operation
  Gate is evaluated before execution, and its Action Attempt is recorded before
  the external call. An unknown outcome blocks blind retry
  ([Osfo Action definitions](../../CONTEXT.md#action)).

These constraints mean a provider firewall cannot grant Action authority, and
an E2B process cannot become an effect executor merely because it can reach the
internet.

## Provider facts that constrain v1

### Egress is permissive unless Osfo overrides it

E2B enables outbound internet by default. Its SDK also treats an omitted
`allowOut` as allowing all outbound traffic. Deny-all can be expressed with
`allowInternetAccess: false` or `denyOut: ['0.0.0.0/0']`, then selected IPs,
CIDRs, or domains may be allowed. Allow rules take precedence over deny rules
([E2B internet access](https://e2b.dev/docs/network/internet-access),
[SDK network types](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/sandboxApi.ts#L95-L169),
[SDK create defaults](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/sandboxApi.ts#L1205-L1217)).
The concrete module must therefore always send a complete explicit network
configuration. Omitting a field is not a safe default.

E2B domain filtering is useful but is not complete isolation. It inspects HTTP
`Host` only on port 80 and TLS SNI only on port 443. Other ports use CIDR rules,
QUIC and HTTP/3 are unsupported, domain use automatically permits E2B's default
DNS resolver, and blocked TCP connects may appear open before application data
is dropped. Separately, Osfo must infer that an allowed multi-tenant domain is
an exfiltration destination because an attacker may control their own resource
under that domain. Treat the allowlist as defense in depth, never as
authorization or a secret boundary
([E2B domain-filter limits](https://e2b.dev/docs/network/internet-access)).

E2B can replace egress settings on a running sandbox. An empty update clears
the rules, and per-host header transforms are public beta and resolved
client-side before being sent to E2B. V1 must not expose this mutability to
sandbox code or rely on header transforms as a secret broker. The concrete
module may use a running update only to tighten a sandbox to deny-all during
quarantine or cleanup
([E2B network updates and transforms](https://e2b.dev/docs/network/internet-access),
[SDK update shape](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/sandboxApi.ts#L184-L201)).

### Public URLs are inbound exposure, even when token-gated

Every E2B sandbox has a port-addressed public URL. It is reachable without
authentication by default. Creating with `allowPublicTraffic: false` requires
the per-sandbox `e2b-traffic-access-token` header, but does not remove the URL
or provide an Osfo authorization layer
([E2B public URLs](https://e2b.dev/docs/network/public-url),
[E2B restricted public access](https://e2b.dev/docs/network/restrict-public-access)).
E2B returns the traffic token alongside the sandbox-scoped controller token at
creation
([SDK create result](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/sandboxApi.ts#L1245-L1251)).

There is no documented per-port traffic-token scope or token rotation. V1
therefore has no inbound/public-URL capability. The module always sets
`allowPublicTraffic: false`, never returns a public URL or traffic token to the
Agent Runtime, sandbox process, client, or artifact, and does not persist the
traffic token. A future preview or callback surface needs its own decision and
an Osfo-authorized proxy. Token-gating the raw E2B URL is not sufficient.

### E2B has three distinct control secrets

1. `E2B_API_KEY` authenticates the SDK and CLI. An API key is scoped to exactly
   one E2B Project, whose sandboxes, templates, billing, and limits it controls
   ([E2B API key](https://e2b.dev/docs/api-key),
   [E2B Projects](https://e2b.dev/docs/projects)). The published API schema
   gives project keys a name and audit timestamps, but no operation scope or
   expiry field. Keys can be created and deleted
   ([API-key schema](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/spec/openapi.yml#L1862-L1940),
   [API-key operations](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/spec/openapi.yml#L3781-L3868)).
2. Secure access, enabled by default in SDK v2, uses a sandbox-scoped controller
   token returned at creation and sent as `X-Access-Token`
   ([E2B secured access](https://e2b.dev/docs/sandbox/secured-access),
   [SDK controller client](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/envd/api.ts#L193-L218)).
3. Restricted public traffic uses the separate per-sandbox traffic token
   described above.

All three are concrete-module control material, not workload credentials. The
production API key lives only in the Cloud Run sandbox module's runtime secret
store. Use a dedicated E2B Project and key per Osfo deployment environment,
rotate by deploying a new key before deleting the old one, and rotate
immediately after suspected worker compromise. The per-sandbox controller
token stays inside the live SDK object. The private E2B sandbox ID remains
inside the concrete module for command, export, and cleanup reconciliation. No control secret belongs
in a Sandbox Profile, E2B metadata, template, sandbox environment, command,
ArtifactRef, log, metric, or ThreadEvent.

E2B metadata is listable and filterable. Although its documentation mentions
API keys as an example metadata value, Osfo must store only non-secret
correlation identities there, such as AgentRun, ToolCall, and lifecycle
operation IDs
([E2B metadata](https://e2b.dev/docs/sandbox/metadata)).

### Sandbox environment variables are not a secret boundary

E2B supports global and per-command environment values, but explicitly states
that command-scoped values are not private from the sandbox OS
([E2B environment variables](https://e2b.dev/docs/sandbox/environment-variables)).
A full pause preserves memory, running processes, loaded variables, and the
filesystem indefinitely. A snapshot likewise captures filesystem and memory
and can seed multiple sandboxes
([E2B persistence](https://e2b.dev/docs/sandbox/persistence),
[E2B snapshots](https://e2b.dev/docs/sandbox/snapshots)). Deleting an
environment entry or temporary file is therefore not proof that its bytes are
absent from a later pause or snapshot.

Paused sandboxes stop billing and are retained indefinitely until explicitly
killed. Billing pressure, plan runtime limits, and timeout are therefore not a
secret-erasure mechanism
([E2B billing](https://e2b.dev/docs/billing),
[E2B paused retention](https://e2b.dev/docs/sandbox/persistence)).

V1 consequently does not inject workload credentials into E2B at all. A
Sandbox Profile cannot name a secret or credential grant. Authenticated source
retrieval happens in a trusted Osfo tool outside E2B, then verified bytes are
staged as immutable sandbox input. Effectful external calls likewise execute
outside E2B through the accepted Action path. Templates contain dependencies,
not credentials. E2B templates are snapshots of a provisioned filesystem and
running processes, so a build secret could otherwise be retained accidentally
([E2B template construction](https://e2b.dev/docs/template/how-it-works)).

If a future requirement cannot be satisfied by outside retrieval and staging,
credential entry is a new decision, not an environment-map extension. At a
minimum it must use a persisted non-secret reference, resolve a read-only,
single-resource, single-operation credential just in time, expire no later than
the command or current claim, support upstream revocation, and treat the
generation as secret-bearing until revocation is confirmed. Those constraints
are intentionally not part of v1.

## Concrete v1 policy

The v1 RunCode Sandbox Profile admits one outbound policy:

```text
DenyAll
```

The module always creates E2B with explicit deny-all egress. It never supports
unrestricted internet or a destination allowlist in v1. Public references,
packages, and authenticated inputs are retrieved by trusted Osfo code outside
the sandbox, verified, and staged as immutable bytes. A later networked-code
profile requires a separate product and security decision.

V1 also fixes these create settings regardless of profile:

```text
secure = true
allowPublicTraffic = false
workload credentials = none
control credentials in sandbox = none
metadata = non-secret correlation IDs only
```

The module validates the returned network and secure-access facts before
dispatching workload. A weaker or uninspectable configuration fails closed.

## Claim loss, cancellation, and accidental secret exposure

Claim loss or cancellation first wins in PostgreSQL and advances or invalidates
the claim epoch. Then the worker and cleanup reconciler:

1. stop any Osfo route to the sandbox and abort local SDK streams;
2. best-effort replace E2B egress with deny-all;
3. revoke any external operation grant held outside E2B;
4. kill the superseded E2B sandbox and retry uncertain cleanup until killed or
   missing; and
5. reject every late command, export, or provider observation as telemetry-only
   under the stale claim epoch.

Network tightening and kill are containment, not the authority fence. E2B has
no per-AgentRunAttempt revocation primitive, so an old trusted worker may retain
an SDK object until kill completes. The database epoch prevents commits, and
the absence of workload credentials or direct Actions prevents that stale
process from holding durable external authority.

If any credential is accidentally exposed to sandbox memory, environment,
filesystem, output, metadata, or a provider snapshot, revoke it upstream,
mark the Sandbox contaminated, and destroy it. Cleanup of bytes alone is insufficient
because E2B pause and snapshot preserve memory and filesystem state.

## Comparable evidence

The OpenAI Agents SDK keeps `E2B_API_KEY` in the host process, while its E2B
client exposes sandbox environment, internet-access, and port options. Its
Python integration defaults internet access to true and enables public traffic
when exposed ports are declared. This is evidence that Osfo must set every
security-sensitive E2B option explicitly rather than inherit SDK defaults
([OpenAI E2B module setup](https://github.com/openai/openai-agents-python/blob/0068ce4329d0af7dd5398c3f300ab178c986495e/src/agents/extensions/sandbox/e2b/sandbox.py#L1-L12),
[OpenAI E2B options](https://github.com/openai/openai-agents-python/blob/0068ce4329d0af7dd5398c3f300ab178c986495e/src/agents/extensions/sandbox/e2b/sandbox.py#L607-L624),
[OpenAI E2B create mapping](https://github.com/openai/openai-agents-python/blob/0068ce4329d0af7dd5398c3f300ab178c986495e/src/agents/extensions/sandbox/e2b/sandbox.py#L1707-L1733),
[OpenAI port mapping](https://github.com/openai/openai-agents-python/blob/0068ce4329d0af7dd5398c3f300ab178c986495e/src/agents/extensions/sandbox/e2b/sandbox.py#L1834-L1837)).

OpenAI's JavaScript SDK also provides a useful future pattern: persist a
non-secret environment-value reference, omit resolved ephemeral values from
durable environment state, and resolve again during rehydration. It does not
make the resolved value private from the sandbox while present, so it does not
justify workload credentials in Osfo v1
([OpenAI environment references](https://github.com/openai/openai-agents-js/blob/432b1e30a6846a7f4d05b1a8b46b652824df8537/packages/agents-core/src/sandbox/manifest.ts#L346-L374),
[OpenAI environment persistence](https://github.com/openai/openai-agents-js/blob/432b1e30a6846a7f4d05b1a8b46b652824df8537/packages/agents-core/src/sandbox/shared/environment.ts#L84-L160)).

Effective AI's first-party account shows pause/resume and both shared and
isolated E2B compute. It publishes no network, credential, or secret lifecycle
contract, so it is not evidence for inheriting credentials or E2B defaults
([Effective AI multi-agent runtime](https://effectiveailabs.com/blog/multi-agent-runtime#shared-and-isolated-compute)).

## Recommendation to put to the user

Freeze v1 around explicit deny-all E2B networking. Always use E2B secure access
and `allowPublicTraffic: false`; expose no
raw E2B public URL. Keep the project API key and sandbox control tokens only in
the concrete Cloud Run E2B module. Put no workload credential or direct Action
authority inside E2B. On claim loss or cancellation, fence in PostgreSQL first,
then close routes, tighten egress, revoke outside grants, and kill the old
sandbox. Any Sandbox that ever receives secret bytes is contaminated and must
be revoked and destroyed.

```text
Cloud Run secret store
  -> concrete E2B module (project key, controller token, traffic token)
       -> E2B sandbox (deny-all egress, no inbound surface, no secrets)
            -> verified files/results

sandbox proposes effect payload
  -> committed Action -> Operation Gate -> recorded Action Attempt
  -> trusted external executor (workload credential) -> external system

claim loss or cancellation
  -> PostgreSQL fence -> close routes -> deny egress -> revoke grants -> E2B kill
```
