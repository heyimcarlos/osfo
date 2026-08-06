# Bounded RunCode capability on E2B

Sources were accessed on 2026-08-05. This note resolves whether Osfo v1's
disposable E2B module should execute only CSV analysis or expose one bounded
Python code-execution ToolCall.

## Recommendation

Expose a product-level `RunCode` ToolCall and keep E2B as its single concrete
v1 implementation. This is not the rejected provider abstraction. `RunCode`
names an immediate user capability shared by CSV, spreadsheet, PDF, image,
document, conversion, calculation, visualization, and generated-file journeys.
It does not pretend that E2B and a hypothetical second provider share an
interface.

Keep the CSV journey as the first golden scenario and certification workload.
Call the internal entry point `executeRunCodeToolCall`. A file such as
`e2b-run-code.ts` may name the concrete implementation. Avoid
`executeCsvAnalysis`, which puts one journey into the module boundary, and
avoid a public `runCodeInE2b` API, which puts the provider into the product
ToolCall contract.

```text
committed RunCode ToolCall
  -> create fresh E2B sandbox
  -> stage immutable named inputs and exact Python source
  -> run one supervised process tree
  -> capture bounded stdout and stderr
  -> validate the program's ordered output manifest
  -> freeze, verify, and store selected regular files
  -> claim-fenced ToolCall outcome commit
  -> kill sandbox and reconcile uncertain cleanup
```

## Minimal durable input

```ts
type RunCodeInputV1 = {
  language: "python"
  source: string
  inputs: Array<{
    name: string
    content: ClientContentRefV1
  }>
  exports: SandboxExportCapabilityV1
}
```

`name` is a unique, normalized logical leaf name, not a caller-selected path or
an original client filename. The supervisor supplies a fixed manifest mapping
those names to staged files. E2B paths never enter durable intent, results, or
ThreadEvents.

The exact UTF-8 source bytes, ordered input bindings, export capability,
language, and pinned Sandbox Profile are immutable ToolCall intent. Source has
no separate ProgramId. The ToolCall is its identity. Every retry uses the exact
same program and inputs in a fresh sandbox. Corrected code is a new ToolCall.
The profile binding comes from the AgentRun's immutable Execution Profile and
is recorded with the private attempt, not selected freely by the model.

## Dynamic outputs without implicit export

Do not predeclare exact output filenames. The committed intent declares the
already accepted bounds on file count, per-file bytes, aggregate bytes, roles,
interpretations, and media types. During execution, the program writes a small,
bounded, ordered output manifest through the fixed supervisor protocol. That
manifest explicitly selects relative files beneath the fixed output root.

Treat the manifest as untrusted output. After execution, Osfo records the
validated selection under the current claim before export, then applies the
accepted race-safe regular-file snapshot and immutable Client Content pipeline.
Reject missing, duplicate, escaping, symlink, non-regular, oversized, or
capability-incompatible selections. Never recursively export a directory.

## Result semantics

- A positively observed process exit is a completed code-execution result.
  It contains the exit status plus bounded stdout and stderr, including for a
  nonzero exit, so the agent can diagnose the program and issue a new ToolCall.
- A nonzero exit is not an infrastructure failure and is never automatically
  retried. Corrected source creates a new ToolCall.
- Verified output selections may project to `ClientResultV1.artifacts` after
  any observed exit when they satisfy the committed export capability. Raw E2B
  errors, paths, source, and provider details remain private.
- Exceeding stdout or stderr limits terminates the process tree and fails the
  ToolCall. Output is never silently truncated into success.

E2B's JavaScript command API accepts a shell command string and accumulates
decoded stdout and stderr in memory. The accepted supervisor remains necessary:
the host sends one constant command, while the helper invokes the staged Python
file without interpolating source, input names, or paths into a shell command
([command API](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/index.ts#L374-L486),
[output accumulation](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/commands/commandHandle.ts#L86-L158)).

## Python, packages, and subprocesses

Start with one literal language, `python`. Do not expose raw Bash in v1. E2B
itself presents `runCode` as a language-selected code capability, including
Python, which supports this product vocabulary without requiring Osfo to adopt
E2B's stateful code-context or result types
([E2B Python code execution](https://e2b.dev/docs/code-interpreting/supported-languages/python),
[E2B code contexts](https://e2b.dev/docs/code-interpreting/contexts)).

The exact template build pins Python, every available library, helper, and
installed OS executable. Runtime package installation remains forbidden. A
package change creates a new Sandbox Profile and reruns live certification.
E2B documents both build-time and runtime installation; Osfo deliberately uses
only the build-time shape for repeatability
([E2B custom packages](https://e2b.dev/docs/quickstart/install-custom-packages)).

Python may create subprocesses within the same supervised process tree and the
accepted 64-process/thread bound. Arbitrary Python can already invoke installed
executables, so forbidding the `subprocess` module would not be a meaningful
security boundary. The real boundary is the disposable non-root sandbox with
no network, credentials, inbound access, background survival, or writable
trusted files. The ToolCall schema still avoids a raw Bash program because a
shell contract would make quoting, command lookup, and template paths part of
the model-facing ABI.

## Security and ownership

General code does not grant general authority. The sandbox can read only its
staged immutable inputs, write private work and output areas, and use the
profile's pinned local software. It has no workload credentials, Action
authority, network access, public ingress, runtime installs, PTY, interactive
stdin, reconnect, pause, persistent workspace, or background-process contract.
One foreground supervisor owns and reaps the complete process tree.

The AgentRun driver still owns claim validity, cancellation, retry budget, and
durable ToolCall identity. PostgreSQL owns the terminal outcome. Client Content
owns immutable exported bytes. E2B owns only disposable isolated computation.
This preserves the accepted record-before-execution and claim-fencing contracts
([AgentRun recovery](https://github.com/heyimcarlos/osfo/issues/12#issuecomment-5161404377),
[Agent Runtime](https://github.com/heyimcarlos/osfo/issues/43#issuecomment-5194875760)).

OpenAI's sandbox workspaces support files, document analysis, commands, and
generated artifacts as one capability family, while keeping paths relative to
a declared workspace. That supports a general file-grounded computation
capability, but its persistent agent workspace is broader than Osfo's one-shot
v1 contract
([OpenAI Sandbox Agents concepts](https://openai.github.io/openai-agents-python/sandbox/guide/)).

## Decision

Replace the CSV-specific module decision with one internal
`executeRunCodeToolCall` deep module, implemented directly with the official
E2B SDK. Freeze Python-only, logical named immutable inputs, exact immutable
source, a bounded export capability plus post-execution output manifest, one
supervised process tree, bounded stdout and stderr, and the previously accepted
artifact, failure, fencing, cleanup, and conformance rules. Certify
`RunCode(Python + CSV) -> summary + chart` first, then reuse the same concrete
capability for PDF and generated-file journeys without redesigning sandbox
lifecycle.
