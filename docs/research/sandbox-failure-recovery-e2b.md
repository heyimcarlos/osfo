# E2B Sandbox Failure and Recovery

All sources were accessed on 2026-08-05. This note resolves only failure,
retry, cancellation, and cleanup for the accepted disposable E2B RunCode
ToolCall in [Define the Sandbox Provider and artifact-export
contract](https://github.com/heyimcarlos/osfo/issues/54).

## Existing Osfo constraints

- One logical ToolCall has one identity, bounded execution attempts, and one
  terminal outcome. A new execution attempt keeps that identity and consumes
  operation retry budget. AgentRun claim takeover alone consumes no operation
  retry budget
  ([AgentRun recovery contract](https://github.com/heyimcarlos/osfo/issues/12#issuecomment-5161404377)).
- The durable driver records intent before execution, owns retry and
  cancellation policy, and fences every authoritative commit by claim epoch.
  Provider observations do not own lifecycle
  ([Agent Runtime contract](https://github.com/heyimcarlos/osfo/issues/43#issuecomment-5194875760)).
- This RunCode ToolCall is a non-Action. It has no workload credentials or
  direct external-effect authority. Action uncertainty prohibits blind retry
  because a request may have changed an external system, while this ToolCall
  may only change its disposable sandbox
  ([Action contract](https://github.com/heyimcarlos/osfo/issues/51#issuecomment-5198169135)).
- The public failure union is already frozen. Attempts, retries, provider IDs,
  sandbox state, raw errors, and cleanup mechanics are absent from
  `ThreadEventRegistryV1`
  ([Thread registry contract](https://github.com/heyimcarlos/osfo/issues/52#issuecomment-5198388884)).

## Provider evidence

The reviewed source is the exact E2B JavaScript SDK `2.38.0` at commit
`998e560a`. The package declares that version directly
([package manifest](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/package.json#L1-L16)).

E2B exposes useful error classes, but they do not determine Osfo policy.
`TimeoutError` covers sandbox expiry, request timeout, command deadline, and
some unknown transport failures. Other classes distinguish invalid arguments,
disk exhaustion, missing files or sandboxes, authentication, template
compatibility, and rate limits
([error types](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/errors.ts#L1-L140)).
The RPC mapping likewise collapses canceled requests, command deadlines, and
sandbox unavailability into `TimeoutError`; an unknown dropped connection is
only refined when a health probe proves the sandbox is gone
([RPC mapping](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/envd/rpc.ts#L69-L144)).
Therefore class name alone cannot decide retry safety.

`commands.run()` waits on a command handle. A successful result requires a
terminal process event; a nonzero exit becomes `CommandExitError`; a stream
that ends without a terminal event does not produce a result
([command dispatch](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/index.ts#L374-L486),
[result handling](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/commandHandle.ts#L160-L208)).
Aborting a request stops the client observation, while command termination is a
separate explicit `SIGKILL` operation. Disconnecting also explicitly does not
kill the command
([command controls](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/index.ts#L272-L310),
[disconnect semantics](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/commandHandle.ts#L184-L208)).
An aborted or timed-out observation is consequently not proof that the command
stopped.

Sandbox kill returns `true` after a successful delete and `false` for a
confirmed 404. Any transport failure leaves deletion unknown
([kill source](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/sandboxApi.ts#L760-L794)).
Create accepts caller metadata but no idempotency key. List can filter by that
metadata. It follows that a lost create response can leave an unknown orphan,
which Osfo can find by a unique attempt marker and kill without adopting it
([create source](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/sandboxApi.ts#L1167-L1217),
[metadata query](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/sandboxApi.ts#L448-L467)).

The OpenAI Agents SDK is a useful normalization comparable, not a contract to
copy. It treats E2B authentication, missing-resource, invalid-argument,
disk-space, and template errors as non-retryable; rate limits, provider
timeouts, and transient HTTP statuses as retryable; then separates command
timeout, nonzero exit, and transport failure in its own error types
([E2B mapping](https://github.com/openai/openai-agents-python/blob/141f59949e823bb6edd55aa2370320ac1476624a/src/agents/extensions/sandbox/e2b/sandbox.py#L91-L169),
[mapped exception sets](https://github.com/openai/openai-agents-python/blob/141f59949e823bb6edd55aa2370320ac1476624a/src/agents/extensions/sandbox/e2b/sandbox.py#L526-L562),
[execution errors](https://github.com/openai/openai-agents-python/blob/141f59949e823bb6edd55aa2370320ac1476624a/src/agents/sandbox/errors.py#L218-L345)).
This supports phase-aware normalization rather than exposing E2B's taxonomy.

## Minimal private taxonomy

Normalize an exhausted operation into only four behavioral cases:

```ts
type SandboxAttemptFailureV1 =
  | {
      type: "terminal"
      phase: SandboxPhaseV1
      code:
        | "invalid_input"
        | "dependency_unavailable"
        | "timeout"
        | "result_invalid"
        | "execution_failed"
      reason: SandboxFailureReasonV1
    }
  | {
      type: "retryable"
      phase: SandboxPhaseV1
      reason: SandboxFailureReasonV1
      retry_after_ms?: SafeInteger
    }
  | {
      type: "uncertain"
      phase: "create" | "stage" | "execute" | "freeze" | "export" | "store"
      reason: SandboxFailureReasonV1
    }
  | { type: "canceled"; phase: SandboxPhaseV1 }
```

`reason` is a closed, private operational enum, for example
`provider_rate_limited`, `transport_lost`, `sandbox_expired`,
`resource_limit`, `output_invalid`, or `profile_mismatch`.
It selects telemetry and a sanitized description, never a new public failure
code. Raw E2B exceptions are evidence used to produce this value, not durable
domain types.

The classification rules are:

- `terminal` means repeating the same profile and input is not expected to
  help. A command deadline is terminal `timeout`; enforced resource exhaustion
  is terminal `execution_failed`; malformed selected
  output, unsafe file type, digest mismatch, or media mismatch is terminal
  `result_invalid`.
- `retryable` is only dependency failure with evidence that no semantic result
  was accepted, such as a rate-limit rejection, provider service outage, or
  transient transport failure before a terminal observation.
- `uncertain` means Osfo lost the observation after the external operation may
  have begun. For this pure ToolCall it is safe to retry, but only in a new
  sandbox. It never becomes Action `needs_attention` or an unresolved
  ActionReceipt.
- `canceled` is selected only when cancellation wins the PostgreSQL race. Late
  success, failure, output, or artifact observations cannot replace it.

## Retry and replacement rules

Every `retryable` or `uncertain` execution retry creates a new private ToolCall
attempt for the same ToolCall identity, consumes one operation retry, applies
durable backoff, and creates a new sandbox. Exhaustion becomes one terminal
public failure: `dependency_unavailable` for create, stage, export, store, or
provider transport failure; `execution_failed` for an execute observation that
was lost. A positively observed command deadline remains `timeout` and is not
retried by default.

AgentRun claim takeover itself consumes no operation retry. If takeover proves
the prior ToolCall attempt never dispatched, it may continue without charging
a retry. If command dispatch may have occurred, any redispatch is a new
ToolCall attempt and consumes budget.

The current sandbox must be retired after claim loss, cancellation, sandbox
loss, command timeout, resource violation, or any ambiguous command outcome.
No command is redispatched into it. A bounded retry of immutable object upload
or E2B streaming from an already frozen, verified snapshot may stay in the same
current attempt and reuse the same logical export identity. That transfer retry
does not redispatch computation and does not consume ToolCall retry budget. If
the snapshot or sandbox is lost, retry the whole ToolCall attempt in a new
sandbox.

Create uses unique, non-secret metadata containing the ToolCall attempt marker.
If create is uncertain, never adopt a later match for execution. Enqueue a
metadata reconciliation that kills every match, then retry in a new sandbox.
This preserves one sandbox generation per attempt without pretending create is
idempotent.

## Profile and configuration failures

Validate the exact SDK, template build, limits, network policy, and helper
compatibility before claiming work. A worker that cannot satisfy the pinned
profile is incompatible, so the AgentRun remains pending with an explicit
private reason and no ToolCall retry budget is spent. Invalid server-owned
profile configuration fails release or startup validation.

If drift or missing credentials are discovered only after an attempt starts,
fail closed. Authentication, missing template, uncertified helper, or capability
mismatch is terminal `dependency_unavailable` for that attempt, without
automatic tight-loop retry. Invalid RunCode input or an input exceeding the committed
profile is `invalid_input`. An E2B `InvalidArgumentError` is not automatically
client invalid input, because it can also reveal an Osfo configuration defect.

## Cancellation and cleanup

Cancellation ordering is:

```text
commit cancellation request and fence the claim
  -> abort in-flight SDK observation
  -> SIGKILL known command with an independent cleanup signal
  -> kill sandbox with an independent bounded deadline
  -> ToolCallResolved(canceled)
  -> AgentRunCanceled(cleanup status)
```

The outcome transaction wins only if its claim is still current and no
cancellation won first. `AbortSignal` is responsiveness, not termination
evidence. Cleanup uses a fresh signal because the workload signal is already
aborted.

`cleanup_pending` is private and may coexist with any committed ToolCall
outcome, including success, failure, or cancellation. Outcome commitment never
waits indefinitely for E2B. A successful kill or confirmed 404 marks cleanup
complete. Timeout or transport failure leaves cleanup pending; the reconciler
retries kill by sandbox ID or unique create metadata until confirmed absent or
the sandbox's configured ten-minute kill timeout has certainly elapsed.
For cancellation, the existing public `AgentRunCanceled.cleanup` reports
`completed` or `deadline_exceeded`; `external_work_may_continue` is true when
termination could not be confirmed by that deadline. No new ThreadEvent or
failure member is added for cleanup.

## Public mapping and private telemetry

| Private result | Retry | Public result when terminal |
|---|---|---|
| invalid RunCode input or input bound | no | `failed.invalid_input` |
| provider/config unavailable | bounded only when classified retryable | `failed.dependency_unavailable` |
| confirmed command deadline | no by default | `failed.timeout` |
| unsafe, malformed, or unverifiable output | no | `failed.result_invalid` |
| observed nonzero command | no automatic retry | completed RunCode result with bounded exit status, stdout, and stderr |
| resource limit or helper failure | no | `failed.execution_failed` |
| ambiguous pure command | fresh sandbox, consumes budget | `failed.execution_failed` after exhaustion |
| cancellation wins | no | `canceled` |

The E2B error class and message, HTTP or RPC code, response headers, request ID,
sandbox ID, template ID, envd version, sandbox domain, access and traffic
tokens, PID, command text, unbounded or unnormalized provider output copies,
sandbox paths, signed URLs,
metrics, timings, retry count, claim epoch, and cleanup attempts remain private.
Credentials and tokens are never logged. Client descriptions are deterministic
and sanitized. `ThreadEventRegistryV1` receives only the existing
`OperationOutcomeV1` and verified `ClientContentRefV1` values.

## Recommended answer

Use a four-case private result: terminal, retryable, uncertain, or canceled.
Only dependency failures with explicit transient evidence retry automatically.
Every computation redispatch uses the same ToolCall identity, consumes its
bounded retry budget, and runs in a fresh disposable sandbox. Ambiguous E2B
execution is safe to replay here because this ToolCall has no Action authority;
it is not Action uncertainty. Fence cancellation first, treat SDK abort as
observation cancellation only, kill independently, and allow private cleanup
debt to coexist with the already committed semantic outcome.

| Durable state | Next action | Sandbox rule |
|---|---|---|
| current attempt, confirmed success | verify and commit outcome | enqueue kill |
| retryable or uncertain | `retry-ready` with backoff and budget effect | retire, then create new |
| terminal failure | commit existing `ClientFailureV1` member | enqueue kill |
| cancellation won | commit canceled ordering | kill with bounded deadline |
| outcome committed, kill unknown | keep outcome, run reconciler | `cleanup_pending` |
| profile incompatible before claim | remain pending | create none |
