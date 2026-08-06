# Mistakes

- 2026-08-05: When updating a GitHub issue body through `jq`, do not place
  escaped newlines inside a `sub` replacement. They can be persisted as literal
  `\\n` text. Re-read the rendered section immediately and replace with actual
  newline characters before considering the tracker update complete.
- 2026-08-05: Do not introduce a provider-neutral Sandbox Provider interface
  when E2B is the only concrete provider. Integrate the official E2B SDK through
  one deep module, test with a mocked E2B client and fault injection, and
  extract a provider seam only after a second real provider exposes actual
  variation.
- 2026-08-05: Do not design a persistent AgentRun-owned sandbox before a real
  journey requires one. Osfo v1 uses one disposable E2B Sandbox per RunCode
  ToolCall. Pause, resume, snapshots, SandboxRef restoration, shared workspaces,
  and cross-run reuse begin only after a concrete later slice proves the need.
- 2026-08-05: Do not name the sandbox module after its first CSV certification
  journey. `RunCode` is the bounded product capability. CSV analysis, PDF work,
  transformations, calculations, visualizations, and generated files reuse its
  Python-first contract without creating a provider abstraction.
- 2026-08-02: Do not classify the whole Rig project as an Agent Runtime. Rig is
  an LLM application library and facade; its `rig-agent` crate provides its
  classic Agent Runtime. Keep a concrete library's identity separate from the
  narrower architectural role one of its modules may fill.
- 2026-08-02: A Temporal container health check cannot assume the frontend is
  bound to container loopback. Probe the Compose service address that clients
  actually use, then keep that probe in the one-command startup path.
- 2026-08-02: Docker tmpfs state disappears across stop and start. Use a
  provider-owned volume when a local SandboxRef promises resumable workspace
  acceleration, and still export authoritative bytes before relying on it.
- 2026-08-02: A synchronous PostgreSQL client cannot be constructed on a Tokio
  runtime thread because it starts its own runtime. Put blocking database work
  on `spawn_blocking` or use an async client at that composition boundary.
- 2026-08-02: IAM database usernames can contain URL-reserved characters.
  Percent-encode the username before placing it in a PostgreSQL URL, without
  printing or persisting the principal.
- 2026-08-02: Quote Cloud Storage recursive URIs in zsh. An unquoted `**`
  expands locally and aborts before `gcloud` can delete the explicit bucket
  objects.
- 2026-08-03: `gcloud sql users create` prints the created IAM principal even
  when the command input is held in a shell variable. Redirect routine command
  output when provisioning identity-bound database users so evidence logs do
  not capture the principal.
- 2026-08-03: A woken AgentRun is generally claimable, so a load executor cannot
  assume the worker that opened a ChildJoin, approval, or awaited workflow will
  also resume it. Dispatch every claim from durable semantic state and yield at
  wake boundaries. Linear in-process continuation races create duplicate stable
  IDs and stale claim epochs.
- 2026-08-03: Prometheus accepts a scrape job with no targets as valid
  configuration. Syntax validation alone therefore cannot prove telemetry
  coverage. Require the expected endpoint in a regression test and fail the
  workload preflight unless every required job is present and healthy.
- 2026-08-03: The remote benchmark shell inherited a soft `nofile` limit of
  1,024, which caused PostgreSQL client construction to panic under the full
  worker fleet. Raise the process limit explicitly and fail before load when it
  is below the benchmark minimum.
- 2026-08-03: Do not combine a per-run row lock and sequence allocation into
  one PostgreSQL statement under `READ COMMITTED`. The statement snapshot is
  taken before it waits for the lock, so a concurrent commit can make the
  sequence maximum stale and cause a duplicate `(run_id, sequence)`. Acquire
  the lock first, then allocate and insert in a second statement whose snapshot
  includes the preceding commit. Keep a concurrent regression test for this.
- 2026-08-03: Cloud Run multi-container flags after `--container` are scoped to
  that container, so global flags belong before the first container. Cloud Run
  worker-pool deploy also lacks a startup-probe flag in gcloud 569.0.0. Use the
  WorkerPool YAML resource when a sidecar dependency requires readiness.
- 2026-08-03: Secret Manager preserves trailing newlines when a generated value
  is piped from a line-oriented command. Generate bearer tokens without a final
  newline and pin the non-secret secret version on the Cloud Run revision.
- 2026-08-03: Debian's `protobuf-compiler` package provides `protoc`, but not
  the well-known type source files required by `prost-wkt-types`. Install the
  pinned distribution's `libprotobuf-dev` package in the Temporal Rust build
  image. Setting `PROTOC_INCLUDE` cannot help a dependency that does not read it.
- 2026-08-03: A binary-only Rust container build still compiles the package
  library. Copy every `include_str!` input, including `schema.sql`, into the
  builder context even when the selected binary never calls that code path.
## 2026-08-03: Reusing a stale Cloud SQL Auth Proxy checksum

The earlier issue 13 evidence recorded a Cloud SQL Auth Proxy 2.24.1 checksum that does not match the checksum published in the official 2.24.1 release. The release also publishes binaries from `storage.googleapis.com/cloud-sql-connectors`, not GitHub release assets. Resolve and verify the exact release URL and checksum from the pinned release before every evidence run.

## 2026-08-03: Treating a manually started proxy as durable infrastructure

The runner reboot removed the manually launched Cloud SQL Auth Proxy and made a
calibration fail with a refused connection. Install the pinned proxy as an
enabled systemd service, bind it to the runner Docker bridge, and verify both a
host database login and the PostgreSQL exporter target before every run.

## 2026-08-03: Leaking Temporal in-flight accounting on database failure

A transient Cloud SQL IAM login failure occurred after a Temporal workflow had
completed but before its outcome was committed. An early `?` exited the
dispatcher without decrementing its in-flight counter, so the run waited for
the full drain timeout. Use an RAII guard for in-flight accounting and retry the
idempotent outcome delivery with the same stable delivery ID. Export the retry
count so a recovered transient remains visible in evidence.

## 2026-08-03: Hashing a console log before its writer exits

The evidence binary hashed `run.log`, then the outer `tee` appended the final
evidence path after the binary exited. This invalidated an otherwise complete
bundle. Treat the externally written console log as ancillary and exclude it
from the internal checksum manifest. Verify both checksum manifests only after
the outer process has exited.

## 2026-08-03: Including the checksum temporary file in its own manifest

The deployed evidence capture used a dot-prefixed checksum temporary file, but
its exclusion pattern only matched names without the leading dot. Exclude both
forms, move the completed manifest atomically, and verify it from the bundle
root because recorded paths are relative to that directory.

## 2026-08-03: Inferring gateway concurrency from fixed service latency

Increasing Temporal gateway concurrency from 64 to 256 assumed service latency
would remain stable. The local Docker sandbox lane saturated instead, Temporal
workflow service p50 rose to about 16 seconds, and end-to-end tail latency did
not improve. Calibrate concurrency with measured queueing and service time.

## 2026-08-03: Constructing a blocking telemetry client in async main

After rebuilding with reqwest 0.13.4, constructing and dropping its blocking
client inside Tokio's async main triggered Tokio's blocking-runtime shutdown
panic. Run blocking Prometheus preflight and evidence capture on a blocking
thread, and keep a regression test that constructs and drops the client there.
The preceding Temporal Cloud connection resets were separate startup transients.

## 2026-08-04: Hiding owner-scoped DDL in runtime startup

The least-privileged AgentRun worker could read and write lifecycle rows but did
not own the table, so an index installation in worker startup caused a deployed
crash loop. Keep schema migration in an explicit owner-scoped command, then run
the application with the narrower runtime identity.

## 2026-08-04: Leaving benchmark SSE requests open after terminal delivery

The first deployed load client opened one SSE request per message, observed the
terminal event, and disconnected, but the server kept each stream logically
open. Superseded Cloud Run revisions continued draining those requests for the
one-hour timeout and kept polling Cloud SQL, which contaminated later stages.
Add an opt-in run-specific terminal cursor for benchmark requests, verify the
response body closes, and confirm old revision instance counts reach zero before
the next stage.

## 2026-08-04: Passing a monitoring access token in a process argument

The first deployed-stage helper expanded a short-lived GCP access token in a
`curl --header` argument. Local process inspection could therefore display it.
Stream authorization configuration to `curl --config -` instead, never inspect
secret-bearing command lines, and keep tokens out of captured output and
evidence bundles.

## 2026-08-04: Using unquoted heredocs for Markdown issue bodies

An issue-creation helper used unquoted heredocs containing Markdown backticks,
so the shell treated inline code as command substitutions and created empty
issue bodies. Quote heredoc delimiters for literal Markdown, populate dynamic
references explicitly, and verify non-empty remote bodies immediately after
creation.

## 2026-08-04: Reusing Pub/Sub ordering keys across benchmark lanes

A failed ordered publish pauses that ordering key. Reusing the key in a later
lane made an otherwise isolated run inherit the earlier publisher failure.
Namespace every ordering key with the immutable benchmark ID and call
`ResumePublish` before retrying a failed ordered publish.

## 2026-08-04: Ignoring unexpected transaction failures in a fault matrix

The first concurrent dual-write matrix used serializable transactions and
ignored the returned errors because every injected request was expected to end
unknown. Unrelated serialization failures then looked like boundary-cut
outcomes. Use the weakest isolation that preserves the point-idempotency
contract, assert the expected outcome of every primary and retry attempt, and
retain the bad matrix as contaminated evidence.

## 2026-08-04: Reusing a push subscription after failure injection

Seeking a Pub/Sub subscription past concluded synthetic messages did not reset
its accumulated push backoff. A later clean lane inherited delayed delivery and
looked capacity-limited. Recreate the manifest-owned subscription from the
frozen configuration between independent lanes and retain the inherited-state
run as contaminated evidence.

## 2026-08-04: Joining delivery evidence through an array for every row

The first stress audit joined every delivery attempt to every admission through
`agent_run_id = ANY(agent_run_ids)`, which became effectively quadratic over
accumulated prototype history. Scope admissions to the benchmark, unnest the
small identity array once, and join the resulting relation by AgentRun ID.

## 2026-08-04: Deriving service-account IDs from an unbounded experiment name

The first B3 stripe-study provision used the full experiment name as its cloud
prefix. Appending `push-auth` exceeded GCP's 30-character service-account ID
limit after Cloud SQL and three accounts had already been created. Keep the
evidence name descriptive, derive a separately bounded cloud prefix, and
validate provider naming limits before provisioning the first resource.

## 2026-08-05: Reusing zsh's read-only status parameter

A monitoring loop assigned a build result to `status`, which zsh reserves as a
read-only special parameter. Use a task-specific name such as
`task_build_status` for shell state captured from external commands.

## 2026-08-05: Assuming zsh supports Bash TCP redirections

A one-off database audit waited on `/dev/tcp`, which Bash supports but zsh does
not. Select `/bin/bash` explicitly for commands that use Bash TCP readiness
checks, or use a portable socket probe.

## 2026-08-05: Aggregating sibling fact tables through their parent

A diagnostic query joined admissions and AgentRuns only through their shared
benchmark before counting distinct rows. That formed the admissions by runs
Cartesian product and had to be canceled. Aggregate each fact table separately,
then join the small per-benchmark results or use correlated scalar counts.

## 2026-08-05: Masking a failed qualification lane in a Bash conditional

A controller called the multi-lane workflow inside `if`, which disabled the
expected `errexit` behavior inside nested functions. A failed lane check was
then followed by an assignment or success message, so the workflow returned
zero. Propagate every lane status explicitly, stop before subsequent commands,
and replay a known failing sealed lane to verify controller state and exit code.

## 2026-08-05: Reusing zsh's special path array

An evidence inventory used `path` as a loop variable. In zsh, `path` is tied to
`PATH`, so the first iteration hid commands such as `rg`, `wc`, and `du`. Use a
task-specific loop name such as `evidence_item`, especially for lowercase zsh
special parameters.
