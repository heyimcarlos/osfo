# E2B Sandbox Artifact Export

All sources were accessed on 2026-08-05. This note resolves only the artifact
export question in [Define the Sandbox Provider and artifact-export
contract](https://github.com/heyimcarlos/osfo/issues/54).

## Existing contracts

- PostgreSQL owns semantic outcomes and `ArtifactRef` metadata. The artifact
  store owns immutable bytes. A sandbox path and `SandboxRef` are never
  authority. Every commit is fenced by the current AgentRun claim
  ([AgentRun recovery contract](https://github.com/heyimcarlos/osfo/issues/12#issuecomment-5161404377)).
- `ClientContentRefV1` is already closed as `{ content_id, media_type,
  byte_length, sha256 }`. `ContentId` is server-issued, non-content-addressed,
  Thread-bound, globally unique within type, and never reused. Referenced bytes
  must be fully stored and integrity-checked before a canonical reference
  commits. They remain retained while a live-Thread authoritative record
  references them
  ([Action and content contract](https://github.com/heyimcarlos/osfo/issues/51#issuecomment-5198169135)).
- Public artifacts are `ClientContentRefV1` values in
  `ClientResultV1.artifacts`. V1 has no second `ArtifactId`, filename, provider
  URL, artifact event family, or active artifact. ToolCall,
  WorkflowInstance, Child AgentRun, and Action terminal events already carry
  their closed outcome types
  ([Thread projection contract](https://github.com/heyimcarlos/osfo/issues/52#issuecomment-5198388884)).

  ```ts
  type ClientResultV1 = {
    content: ClientContentV1[]
    artifacts: ClientContentRefV1[]
  }
  ```

  This exact frozen wire type cannot carry a public artifact wrapper without a
  new protocol profile.
- Counts and encoded-byte limits are finite deployment and certification
  configuration, not universal wire constants. Content is rejected or fully
  externalized, never truncated
  ([Thread projection bounds](https://github.com/heyimcarlos/osfo/issues/52#issuecomment-5198388884)).
- [Choose the GCP deployment and IaC
  contract](https://github.com/heyimcarlos/osfo/issues/45) is still open. This
  decision can require an immutable object store without preempting its product
  choice. Cloud Storage is the concrete Oz mapping if that ticket selects it.

## Provider facts

E2B offers export transport, not an authoritative artifact system.
`files.getInfo()` returns path, type, byte size, modification time, and symlink
target. `files.read()` can return a `ReadableStream<Uint8Array>`, with separate
handshake and stream-idle cancellation. The methods are separate calls and the
SDK exposes no open file descriptor, no `O_NOFOLLOW` option, and no atomic
stat-plus-read operation
([E2B file information](https://e2b.dev/docs/filesystem/info),
[E2B filesystem source at `998e560a`](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/filesystem/index.ts#L86-L164),
[streaming read source](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/filesystem/index.ts#L398-L570)).
Consequently, `getInfo()` followed by `read()` alone has a path and mutation
race and is insufficient for authoritative export.

E2B also offers signed download URLs, but those are temporary transport from a
provider sandbox. They are not stable identity, integrity metadata, retention,
or Thread authorization and must never enter Osfo records
([E2B downloads](https://e2b.dev/docs/filesystem/download)). E2B custom file
metadata is stored as sandbox-visible extended attributes, is replaced on
overwrite, and is therefore an untrusted hint rather than Osfo metadata
([E2B file metadata](https://e2b.dev/docs/filesystem/metadata)).

The useful OpenAI Agents SDK comparison is narrower than its name suggests.
Its local materializer rejects absolute and escaping manifest paths, rejects
symlinks, opens every component with `O_NOFOLLOW`, verifies the opened leaf is
a regular file, and hashes the same open handle used for copying
([manifest path validation at `0068ce43`](https://github.com/openai/openai-agents-python/blob/0068ce4329d0af7dd5398c3f300ab178c986495e/src/agents/sandbox/manifest.py#L287-L325),
[pinned traversal and copy](https://github.com/openai/openai-agents-python/blob/0068ce4329d0af7dd5398c3f300ab178c986495e/src/agents/sandbox/entries/artifacts.py#L341-L559)).
That is the right race-resistant shape for the concrete E2B module to implement
privately. Its E2B backend itself reads a whole file into memory, and its tar
workspace fallback base64-encodes the whole archive, so it is not a model for
bounded authoritative export
([E2B read implementation](https://github.com/openai/openai-agents-python/blob/0068ce4329d0af7dd5398c3f300ab178c986495e/src/agents/extensions/sandbox/e2b/sandbox.py#L1113-L1135),
[tar persistence](https://github.com/openai/openai-agents-python/blob/0068ce4329d0af7dd5398c3f300ab178c986495e/src/agents/extensions/sandbox/e2b/sandbox.py#L1483-L1519)).

Effective AI's first-party article documents pause and resume around durable
agent waits, but publishes no artifact export, hashing, object finalization, or
commit protocol. Its public organization has no inspectable runtime source for
one. It supplies no additional artifact evidence
([Effective AI runtime](https://effectiveailabs.com/blog/multi-agent-runtime),
[Effective AI repositories](https://github.com/orgs/effectiveailabs/repositories)).

## Recommended v1 contract

### Declare capability, then select files

An operation does not need to predict exact filenames. Before execution, its
immutable intent commits a bounded export capability:

```ts
type SandboxExportCapabilityV1 = {
  max_files: SafeInteger
  max_bytes_per_file: SafeInteger
  max_total_bytes: SafeInteger
  allowed: Array<{
    role: ArtifactRoleV1
    interpretation: ArtifactInterpretationV1
    media_types: string[]
  }>
}
```

After execution stops and before export or outcome commitment, the operation
explicitly selects one ordered, duplicate-free list:

```ts
type SandboxExportSelectionV1 = {
  relative_path: string
  role: ArtifactRoleV1
  interpretation: ArtifactInterpretationV1
  media_type: string
}
```

The selection must fit the committed capability. Osfo records the whole
selection privately under the current claim epoch and ToolCall attempt
before reading any file. Its ordinal is the stable retry key. This is explicit
selection, not recursive discovery or export of every changed file. An empty
selection is valid. A dynamic directory-shaped result may select one archive
file without predicting its filename before execution.

The same ordering applies to a non-Action ToolCall, WorkflowInstance terminal
delivery, Child AgentRun terminal outcome, and Action evidence. Selected order
becomes domain `ArtifactRefV1[]` order and, after projection, the order of
`ClientResultV1.artifacts`. No path becomes a public filename or changes
`ThreadEventRegistryV1`.

### Normalize and take a race-safe snapshot

Each operation receives one fixed root such as
`/home/user/osfo/<operation-id>/out`. A selected path must be canonical POSIX,
relative, non-empty, contain no NUL, backslash, `.` or `..` component, and
remain beneath that root. Absolute paths are invalid. Every component and the
leaf must be non-symlink, and the leaf must be a regular file. Directories,
sockets, devices, and FIFOs are rejected.

The stable contract requires a race-safe immutable snapshot of each selected
regular file before remote streaming. Path verification and byte capture must
operate on the same opened file, reject symlink traversal, and detect source
mutation. Export reads only the resulting snapshot. `getInfo()` followed by
`read()` on the mutable source does not satisfy this requirement.

How the concrete E2B module freezes a file is private. A small protected helper
in the pinned E2B template can stop remaining user processes, traverse beneath
the output root with no-follow semantics, copy one verified open descriptor to
a protected staging path, and record its length and SHA-256. If E2B later
provides an equivalent atomic primitive, the module may replace the helper
without changing the contract. A lease takeover or possible overlapping
attempt never reuses the disposable sandbox.

Directories are not exported implicitly. A `.tar`, `.tar.gz`, or `.zip` is an
ordinary regular-file artifact and is never extracted by the export path.
Archive safety belongs to a later consumer.

### Bounds and media type

The immutable Sandbox Profile caps the maximum export capability and supplies
transfer and idle deadlines. Each operation may commit stricter finite bounds.
The concrete Oz values are certification configuration, consistent with the
closed Thread contract. Validate capability at intent commit, count and allowed
role, interpretation, and media combinations at selection commit, staged size
before transfer, and per-file plus aggregate bytes while streaming. Any excess
aborts the stream and commits no success reference. Bytes are never truncated.

The selection chooses a media type permitted by its committed interpretation.
Do not infer it from a path, E2B metadata, or filename. Normalize and validate
it against the capability's finite allowlist. Use `application/octet-stream`
when the interpretation promises only opaque bytes. A structured
interpretation names a versioned validator; validation failure is
`result_invalid`. The public projection retains the validated media type inside
`ClientContentRefV1`; richer role and interpretation remain in the domain
`ArtifactRefV1`.

### Stream, verify, and finalize storage

For each selected file, in order:

1. Under the current claim or delivery fence, insert or reuse one private
   export row keyed by `(owner_kind, owner_id, selection_ordinal)`. Allocate its
   stable server-issued `cnt_` ContentId once and mark it `pending`.
2. Call E2B `files.getInfo()` on the root-owned staged path, require a regular
   file and the expected size, then call `files.read(path, { format: "stream"
   })`. Never use `downloadUrl()`.
3. Stream once through bounded counters, SHA-256, the media validator, and an
   Osfo-owned resumable upload to a unique staging object. Do not buffer the
   whole file in Cloud Run.
4. Verify the E2B stream's length and SHA-256 against the trusted finalizer
   record. Verify the object store's transfer checksum and exact stored length.
5. Copy or rewrite that exact staging object generation to the immutable final
   key for the ContentId with create-if-absent semantics. Record the final
   object generation privately and verify its metadata before it is eligible
   to commit.

For a Cloud Storage implementation, use CRC32C validation for the transfer,
the exact source generation, and `ifGenerationMatch=0` on the final object.
Cloud Storage documents server-side checksum comparison, generation-pinned
copy, and the zero-generation precondition as create-only
([Cloud Storage data validation](https://docs.cloud.google.com/storage/docs/data-validation),
[Cloud Storage request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)).
SHA-256 remains the Osfo byte identity check because Cloud Storage's native
checksums are CRC32C or MD5.

### One visibility transaction

After every referenced object is finalized and verified, one PostgreSQL
transaction:

1. revalidates the current AgentRun claim epoch and ToolCall attempt, or the
   corresponding idempotent Workflow outcome-delivery authority;
2. marks each content row `ready` with Thread binding, ContentId, media type,
   exact byte length, lowercase SHA-256, and private object generation;
3. commits the owning domain outcome with ordered `ArtifactRefV1[]`; and
4. projects only each `ArtifactRefV1.content` into the ordered
   `ClientContentRefV1[]` required by its already-defined ThreadEvent, then
   commits that event in canonical order.

Owner-specific ordering stays inside the already-frozen event families:

- A non-Action ToolCall makes content ready in the `ToolCallResolved`
  transaction.
- An awaited WorkflowInstance makes content ready with
  `WorkflowInstanceResolved`, then `ToolCallResolved` and `WaitResolved` in the
  frozen canonical order. A detached workflow uses its idempotent outcome
  delivery and remains bound to the originating Thread.
- A Child AgentRun makes content ready in the transaction that records its
  terminal outcome, advances its ChildJoin, and possibly wakes the parent.
- An Action makes any client-safe content evidence ready with its terminal
  ActionReceipt. Bytes material to the exact Action intent must already be
  exported before that Action is committed, usually as the result of a prior
  non-Action ToolCall. After possible external dispatch, export failure never
  changes `applied`, `not_applied`, or `unresolved`; optional public evidence is
  omitted rather than falsifying effect knowledge.

No new event family is introduced. Objects can exist before this transaction,
but no client-visible reference can.

```text
committed bounded capability
  -> explicit ordered selection
  -> race-safe regular-file snapshot
  -> bounded read stream + SHA-256
  -> staging object
  -> immutable final object
  -> PostgreSQL: content ready + semantic outcome + existing ThreadEvent
  -> staging cleanup + sandbox kill
```

### Retry, deduplication, and cleanup

- Retry by the stable export-row key. An uncertain upload inspects the exact
  staging or final object generation and checks length and checksums. Matching
  bytes continue; absent bytes retry; conflicting bytes fail closed. Deletes
  use generation preconditions.
- An uncertain PostgreSQL commit reads the export row and operation outcome.
  `ready` returns the same ContentId; `pending` resumes finalization. It never
  allocates another ContentId for that selected ordinal.
- Claim loss prevents the visibility transaction. Uploaded objects remain
  private pending data and cleanup debt. A replacement attempt may reuse them
  only after full verification against the stable export record.
- Path, media, structure, byte-limit, or hash disagreement is `result_invalid`
  for a result-producing operation. Temporary E2B or object-store failure
  remains retryable private state; a terminal dependency failure uses the
  existing client-safe failure union. No provider error enters a ThreadEvent.
- V1 performs no semantic or physical content deduplication. Equal bytes from
  two logical exports receive different ContentIds and objects. Only a retry
  of the same owner and selected ordinal reuses identity.
- After the visibility transaction commits, delete the staging object and the
  in-sandbox staged copy, then kill the disposable sandbox.
  Cleanup uncertainty never rolls back the semantic outcome. Abandoned pending
  uploads and orphan objects are reconciled by generation-safe deletion.

### Authorization, retention, and corruption

Every content row binds one Thread and its owning operation. ToolCalls, Actions,
WorkflowInstances including detached ones, and Child AgentRuns resolve to that
same Thread before export. Retrieval authenticates the current Principal and
authorizes that Thread on every request. Unknown, foreign-Thread, and
unauthorized references remain indistinguishable `404` responses, exactly as
the existing content contract requires.

Retain bytes while any live-Thread authoritative record references them. V1
has no independent content deletion or replacement API. Delete physical bytes
only after Thread retention proves no authoritative reference remains.

Before commit, missing or corrupt bytes are an export failure and no reference
is exposed. After commit, a missing object, length mismatch, SHA-256 mismatch,
or wrong generation fails retrieval closed and raises an integrity incident.
Never substitute sandbox bytes or different bytes behind the ContentId. A
repair may restore only independently verified bytes with the exact committed
length and SHA-256, with private audit evidence.

## ArtifactRefV1 and the frozen client projection

Keep the richer semantic value in the domain model:

```ts
type ArtifactRoleV1 = {
  id: string
  version: SafeInteger
}

type ArtifactInterpretationV1 = {
  id: string
  version: SafeInteger
}

type ArtifactRefV1 = {
  content: ClientContentRefV1
  role: ArtifactRoleV1
  interpretation: ArtifactInterpretationV1
}
```

`ArtifactRefV1` is a durable domain value, not a separate entity. It has no
`ArtifactId`; its bytes retain their existing ContentId. The owning operation's
versioned definition governs allowed role and interpretation references and
their validators.

Issue 52 does not permit this wrapper directly in a ThreadEvent:

```text
domain outcome:  ArtifactRefV1[]
                         |
                         | exact client-safe projection: .content
                         v
frozen wire:     ClientContentRefV1[]
```

PostgreSQL stores the domain outcome and private export relation. Session
projects `ArtifactRefV1.content` into the existing client result or Action
content-evidence member. Role and interpretation remain available to Osfo
recovery and operation semantics, while clients receive the exact frozen wire
type. Making them client-visible later requires a new protocol profile; it is
not smuggled into media type, filename, or an unknown field.

## Required verification

Unit and fault tests mock the official E2B client, including `getInfo`, stream
chunks, cancellation, dropped reads, duplicate callbacks, and late success.
They cut execution before and after selection commit, pending-row creation,
upload completion, final copy, PostgreSQL commit, and cleanup. Golden
assertions require one ContentId per selected ordinal and no visible reference
before the final transaction. Real E2B certification additionally exercises path escape,
symlink, hard-link, source mutation, oversized stream, corrupt and truncated
stream, process loss, claim takeover, and missing or corrupt committed objects.
V1 does not build a fake second provider.

## Recommendation to put to the user

Freeze v1 as a concrete E2B-to-Osfo export pipeline: an operation predeclares a
bounded export capability, then explicitly selects an ordered bounded set of
files after execution. The E2B module takes a race-safe regular-file snapshot
by private means, and Cloud Run streams it through byte limits, SHA-256, and
media validation into create-only immutable storage. One fenced PostgreSQL
transaction then makes the content ready, commits domain `ArtifactRefV1`
values containing content plus role and interpretation, and projects only
their `ClientContentRefV1` members into the existing ThreadEvent. Add no
ArtifactId or event, perform no cross-export deduplication, and never expose an
E2B path or signed URL.
