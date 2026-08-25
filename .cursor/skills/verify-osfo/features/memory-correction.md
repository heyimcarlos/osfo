# Correct remembered information

Memory correction lets a User replace an earlier fact and later receive the corrected fact, confirmed details, and useful cross-session associations without teaching Osfo assistant claims, hypotheticals, or fiction as User facts.

## Sub-features

- `memory-pre-index` makes the newest unindexed correction available immediately from recent turns.
- `memory-stable-document` updates the same conversation document with a complete snapshot.
- `memory-searchable` waits for corrected source searchability independently of processing status.
- `memory-derived-positive` derives the correction, an explicit confirmation, and a remembered-person opportunity association.
- `memory-derived-negative` rejects assistant-only, hypothetical, and fictional claims.
- `memory-cleanup` deletes the synthetic User's provider knowledge after the run.

## How to get to it (user POV)

- Tell Osfo a durable fact in one conversation, then correct that fact in a later message.
- Explicitly confirm a fact after Osfo asks about it.
- Mention a person and organization in one Session, then mention a related opportunity in a later Session.

## Driving it with the Supermemory live harness

Preconditions:

- `apps/worker/.env` contains a valid `SUPERMEMORY_API_KEY`.
- `control-osfo doctor-live` reports credential presence and the expected commit.
- No other run uses the generated synthetic User ID.

- **Save the original conversation.** The live harness records the original workshop city, explicit confirmation, remembered person, and negative examples through the real Supermemory adapter.
- **Bridge the correction.** Before indexing completes, prompt assembly must return the corrected city from a `recent-unindexed` source.
- **Update the snapshot.** The harness appends the correction to the full conversation and requires the same provider document ID.
- **Wait for retrieval.** The harness waits for `done`, then separately waits until hybrid search returns the corrected source.
- **Prove semantic extraction.** Derived recall must contain the corrected city, confirmed project, and remembered-person opportunity association. It must omit the assistant-only, hypothetical, and fictional claims.
- **Run and capture proof.** Execute `./.cursor/skills/verify-osfo/helpers/control-osfo drive-live <run-id> memory-correction`. It must exit 0 and retain all four evidence files under `artifacts/verification/osfo/<run-id>/`.

## Gotchas

- This is a live application-adapter qualification, not a browser or messaging journey. Report that limitation with the result.
- Provider `done` does not guarantee searchability. Require the later searchable stage.
- Derived memories can take several minutes. The harness uses real time and bounded polling.
- Immediate hybrid retrieval of the remembered person's original source is query-sensitive. The derived association is the required positive result.
- The finalizer normally deletes all synthetic User knowledge. Audit recent provider documents after an interrupted process because termination can skip cleanup.
