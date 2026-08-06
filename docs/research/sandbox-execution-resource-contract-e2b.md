# E2B RunCode execution and resource contract

All sources were accessed on 2026-08-05. This note resolves one decision for
[Define the Sandbox Provider and artifact-export contract](https://github.com/heyimcarlos/osfo/issues/54):
the concrete execution and resource shape of Osfo v1's disposable E2B-backed
RunCode ToolCall.

## Accepted scope

V1 does not place the Agent Runtime in E2B. The AgentRun loop remains in Cloud
Run. One RunCode ToolCall creates one E2B sandbox, stages immutable logically
named inputs and exact Python source, runs one bounded supervised process tree,
returns bounded stdout, stderr, and exit status, exports an optional ordered
set of dynamically selected files, commits the ToolCall outcome, and destroys
the sandbox. CSV analysis is the first certification journey, not the module
boundary.

There is no v1 pause, resume, snapshot, `SandboxRef`, persistent workspace,
shared sandbox, cross-AgentRun reuse, background job, PTY, interactive stdin,
runtime package installation, or provider abstraction. The official E2B SDK is
mocked directly in unit and fault tests.

## Provider facts

### E2B's command API is a shell API

The JavaScript SDK accepts one command string and implements it as
`/bin/bash -l -c <string>`. It separately accepts `cwd`, `user`, `envs`,
`stdin`, output callbacks, and `timeoutMs`. `stdin` defaults to false and the
command timeout defaults to 60 seconds
([command options](https://github.com/e2b-dev/e2b/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/index.ts#L43-L90),
[bash invocation](https://github.com/e2b-dev/e2b/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/index.ts#L382-L464)).

AgentRun orchestration must therefore not pass an E2B command string. It passes
the typed RunCode input. The concrete module stages the exact Python source and
logical input manifest, then calls one constant command:

```text
/opt/osfo/bin/run-code-python-v1
```

No path, CSV value, prompt text, environment value, or generated Python source
is interpolated into that shell string. Shell execution is an E2B transport
detail. OpenAI's first-party E2B client provides a useful comparison: its public
execution call takes argument parts and uses `shlex.join` only at its E2B edge
([OpenAI E2B implementation](https://github.com/openai/openai-agents-python/blob/cce949a3fc3e589a5d0b6bd4a1ba1e6a78a53b9b/src/agents/extensions/sandbox/e2b/sandbox.py#L898-L949)).

### E2B output is not byte-bounded

Callbacks stream stdout and stderr, but the JavaScript `CommandHandle` also
appends every decoded chunk to in-memory strings. `CommandStartOpts` exposes no
output-byte limit
([accumulation](https://github.com/e2b-dev/e2b/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/commandHandle.ts#L86-L158),
[event handling](https://github.com/e2b-dev/e2b/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/commandHandle.ts#L270-L317)).

V1 must not stream untrusted Python output through `commands.run()`. The trusted
template helper captures stdout and stderr through bounded pipes into protected
files. The E2B command stream carries only one small, bounded helper status.
Text is returned after completion, not live-streamed. Crossing either text cap
terminates the analysis and returns `output_limit_exceeded`; bytes are not
silently truncated into an apparently successful result.

### E2B command timeout is not termination proof

The SDK documents `TimeoutError` for sandbox timeout, request timeout, command
deadline, and some unknown cases. A command handle's `kill()` sends SIGKILL to
the reported PID, but E2B does not document that this proves every descendant
has stopped
([timeout errors](https://github.com/e2b-dev/e2b/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/errors.ts#L23-L38),
[command kill](https://github.com/e2b-dev/e2b/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/commandHandle.ts#L184-L207)).

The trusted helper supervises one process group, applies the command deadline,
kills and reaps the group on failure, and refuses success while descendants
remain. Any E2B timeout, lost stream, uncertain helper status, failed reaping,
or cancellation destroys the whole sandbox. Confirmed E2B kill or an already
missing sandbox is the v1 proof that no sandbox process remains.

### Resources are sandbox-level

E2B configures CPU and memory when building a template. In SDK 2.38.0 the build
defaults are 2 vCPU and 1,024 MB. Disk is not configurable per template or
sandbox; it is 10 GB on Hobby and 20 GB on Pro. E2B exposes CPU, memory, and disk
metrics sampled every five seconds, but those metrics are observations, not a
per-command enforcement API
([SDK build defaults](https://github.com/e2b-dev/e2b/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/template/index.ts#L1058-L1069),
[template resources and disk](https://e2b.dev/docs/template/build),
[billing and limits](https://e2b.dev/docs/billing),
[metrics](https://e2b.dev/docs/sandbox/metrics)).

E2B exposes no JavaScript option for per-command CPU, memory, disk, process
count, or output bytes. V1 must state the actual boundary accurately:

- E2B enforces the sandbox's template CPU and memory allocation, project-tier
  disk, and sandbox lifetime.
- Osfo enforces input, text-output, artifact, and wall-clock bounds.
- The pinned template helper applies a hard process-count limit to the fixed
  non-root execution user. This guest-OS control requires live E2B conformance
  certification and is not represented as an E2B SDK feature.
- Metrics support telemetry and diagnosis only. Polling them cannot prove a
  limit was continuously respected.

## Exact v1 contract

### Pinned production profile

The first production profile pins:

- `e2b@2.38.0` exactly;
- one exact `<template>:<build_id>`, never `default`, `latest`, or another
  movable tag;
- 2 vCPU and 1,024 MB RAM;
- the production project's 20 GB Pro-tier sandbox disk;
- Python, library, and installed utility versions inside that exact build;
- the exact `run-code-python-v1` and race-safe artifact-freezing helpers;
- an unprivileged `osfo` execution user and a hard 64-process/thread limit;
- the already accepted deny-by-default network and no-workload-credential
  policy.

E2B explicitly supports creating from a build ID, while tags can be reassigned
([template build pinning](https://e2b.dev/docs/template/tags#referencing-a-specific-build)).
Changing any item creates a new immutable profile version and requires the live
certification corpus. There is no runtime capability negotiation.

The initial bounded values are deliberately small and are first certified by
the CSV journey:

| Bound | V1 value |
|---|---:|
| Aggregate staged input bytes | 32 MiB |
| Python source bytes | 256 KiB |
| Captured stdout | 256 KiB |
| Captured stderr | 256 KiB |
| Python process-tree deadline | 5 minutes |
| Sandbox timeout from creation | 10 minutes, `onTimeout: "kill"` |
| Process/thread count for execution UID | 64 |

Artifact count, per-file bytes, aggregate bytes, media types, and export
deadlines use the separately accepted bounded export capability. They are
validated before execution and again when the post-execution selection is
committed. An input or requested capability above these bounds is rejected
before E2B creation. A larger future profile is a versioned product decision,
not a mutable exception.

### Workspace and permissions

Every sandbox starts clean and uses one fixed layout:

```text
/workspace/input/       root-owned, directories 0555, staged inputs 0444
/workspace/program/     root-owned, Python source and invocation 0444
/workspace/work/        osfo-owned, 0700, command cwd
/workspace/output/      osfo-owned, 0700, only exportable root
/workspace/control/     root-owned, 0700, helper status and frozen files
/opt/osfo/bin/          exact template helpers, root-owned, not writable
```

Input bindings use normalized logical leaf names, never client paths or E2B
paths in durable state. The execution user cannot mutate inputs, program,
control state, or helpers. The
command receives a fixed `cwd=/workspace/work`, a closed stdin, no caller-chosen
user, and a minimal explicit environment containing only fixed locale, `PATH`,
`HOME`, `TMPDIR`, and non-secret invocation identifiers. It inherits no
sandbox-create environment and receives no credential.

Only regular files beneath `/workspace/output` may be selected after execution.
The selection is explicit and ordered, not a recursive scan. Paths and bytes
then follow the accepted race-safe `ArtifactRefV1` export contract. An
`ArtifactRefV1` contains its `ClientContentRefV1`, role, and interpretation and
has no second identity.

### One foreground execution

There is one semantic foreground command. The concrete module may ask E2B for a
background handle internally so it learns the PID before waiting, but that is
only cancellation plumbing. The PID and E2B command handle are private and are
never durable intent or recovery authority.

Before dispatch, the owning ToolCall's exact source bytes, ordered logical input
bindings, export capability, bounds, current claim epoch, and private
execution-attempt ID are durable.
V1 never reconnects to that PID, carries it across an AgentRunAttempt, or lets a
process survive the ToolCall. One supervised process tree may contain bounded
Python subprocesses, but no process may detach or outlive the ToolCall. A
positively observed nonzero Python exit is a bounded ToolCall result with exit
status, stdout, and stderr. It is not automatically an AgentRun failure or an
automatic retry.

### Cleanup and reconciliation

Success ordering is:

1. Finish and reap the RunCode process tree.
2. Commit the ordered dynamic file selection under the current claim.
3. Freeze, stream, hash, validate, and make selected content ready.
4. In one fenced transaction, commit the ToolCall outcome and its
   `ArtifactRefV1` values, and persist sandbox cleanup debt.
5. Call E2B `kill()` in `finally`; mark cleanup complete only after `true` or
   already-missing `false`.

E2B kill returns `false` when the sandbox is already missing, making repeated
cleanup safe
([kill behavior](https://github.com/e2b-dev/e2b/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/sandboxApi.ts#L754-L794)).

On cancellation, claim loss, deadline, output excess, resource exhaustion, or
uncertain execution, fence authority and persist cleanup debt first, abort local
streams, then kill. No late output or artifact becomes authoritative. A
reconciler repeatedly kills cleanup debt and any E2B sandbox carrying Osfo
metadata that has no matching open disposable ToolCall. Raw E2B IDs remain
private operational data.

## Normalized outcomes

Only these distinctions influence ToolCall or AgentRun recovery:

| Normalized observation | Meaning and recovery |
|---|---|
| `command_exited` | Exit code plus bounded stdout/stderr. A semantic ToolCall result. |
| `input_limit_exceeded` | Rejected before creation. Non-retryable without changing the request or profile. |
| `output_limit_exceeded` | Helper stopped execution, sandbox destroyed. Non-retryable unchanged. |
| `command_deadline_exceeded` | Sandbox destroyed. Retry only under the ToolCall's existing bounded retry policy. |
| `resource_exhausted` | Memory, disk, or process ceiling. Non-retryable unchanged. |
| `sandbox_temporarily_unavailable` | Rate limit, transient control-plane, or create failure. Retry with bounded backoff. |
| `sandbox_profile_invalid` | Authentication, billing, exact build, SDK, helper, or compatibility failure. Operator/configuration failure. |
| `execution_outcome_unknown` | Lost stream or ambiguous provider timeout. Destroy, then retry only under the existing ToolCall retry budget. |
| `artifact_export_failed` | No success outcome until the accepted export pipeline completes or its retry budget is exhausted. |
| `cleanup_pending` | Outcome may already be committed; reconciliation continues independently. |

Provider exception classes, HTTP status, request IDs, sandbox ID, PID, template
internals, raw error text, and CPU, memory, and disk samples remain private
telemetry. They do not enter `ThreadEventRegistryV1`. Client-visible failure is
the existing normalized ToolCall or `AgentRunFailed` cause.

## Required verification

Unit and fault tests mock the official E2B client and cut every boundary before
and after create, stage, command start, helper completion, output-limit kill,
selection, export, outcome commit, and kill. Live certification against the
exact profile proves input permissions, fixed user, no network, CPU and memory
allocation, 64-process limit, five-minute deadline, bounded output behavior,
descendant cleanup, dynamic artifact selection, symlink and mutation rejection,
10-minute auto-kill, idempotent kill, and orphan reconciliation. Metrics are
retained as evidence but never substituted for an enforcement test.

## Recommendation to put to the user

Freeze v1 as one disposable E2B-backed RunCode ToolCall. Pin `e2b@2.38.0` and
one exact 2-vCPU, 1-GiB template build. Stage bounded immutable logically named
inputs and exact Python source under a fixed workspace, run one non-interactive
supervised process tree through a constant trusted helper as a non-root user,
fail closed on five-minute or 256-KiB-per-stream bounds, dynamically select
bounded regular-file artifacts, commit the observed exit result and verified
`ArtifactRefV1` values, then kill in `finally` and reconcile any orphan. Expose
no raw E2B command, PID, background process, PTY, persistent workspace, pause,
resume, or provider abstraction. Certify CSV analysis as the first golden
journey.

```text
durable ToolCall intent
  -> E2B create(exact build, 10-minute kill timeout)
  -> stage read-only named inputs + exact Python
  -> one bounded non-root process tree
  -> exit status + bounded stdout/stderr + ordered file selection
  -> freeze, verify, export
  -> fenced outcome commit + cleanup debt
  -> E2B kill -> reconciled missing
```
