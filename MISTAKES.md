# Mistakes

Record mistakes that can affect the current Osfo implementation. Keep each entry
short, specific, and actionable.

- Cold renderer image downloads can consume test and Worker readiness budgets.
  Prepare the unchanged image in a separately bounded CI step, then reuse Docker
  layers while keeping test execution and readiness checks bounded.

- Starting Scheduled Email evidence resets the shared Integration provider ledger.
  Observe Immediate Gmail before that reset; defer only its evidence finish until
  retained account-deletion replay supplies the deletion receipt.
- Different `127.0.0.1` ports share browser cookies. Keep one authenticated
  verification run per Chrome profile; tabs and automation session names do not
  isolate authentication.

- A provider request ledger includes rejected attempts and typing events. Browser
  evidence must select the intended channel and show only accepted messages.
  Wait for the actual reply before restarting the Worker for an observation.

- Local model fixture matching must stop at the latest substantive User request.
  Searching older requests until a pattern matches can replay a completed action
  instead of selecting the current request. Skip only synthetic continuations.

- When an accepted research handoff explicitly supersedes repository and issue
  state, derive the new documents and issue graph from the handoff first. Do not
  preserve stale worktree or GitHub assumptions as constraints.
- Quote shell search patterns that contain Markdown backticks. Unquoted backticks
  cause the shell to execute the enclosed text instead of searching for it.
- Run Worker Vitest configs from `apps/worker`; their include patterns are relative
  to that package directory, even when the config path resolves from the repo root.
- Build Git-derived formatter paths and run the formatter from the same repository
  root; package-relative working directories make those paths invalid.
- After a production messaging deployment, send a real channel message and observe
  the reply. CI and a Worker health probe do not exercise Telegram through the
  Agent lifecycle.
- Reconciliation must preserve the first immutable outbox payload when later
  history changes. Exact payload equality on an existing committed-turn identity
  can prevent an Agent from activating.
- Adding a generated Agent SQLite migration is incomplete until the runtime
  manifest imports it. Keep a test that compares generated SQL files with the
  manifest imports so package tests exercise the production migration chain.
- A Capability Catalog entry does not prove an existing Tool was migrated. Trace
  every Tool named by an acceptance criterion through its catalog requirement,
  closed registry entry, model-visible schema, and existing execution path.
- Supermemory rejects an organization `filterPrompt` unless the same settings
  update enables `shouldLLMFilter`. Qualify coupled provider settings live, not
  from the generated request type alone.
- When a governing contract moves activation to complete-system qualification,
  do not keep a finished capability ticket open on that activation gate. Verify
  that the capability retained its bounded evidence, then leave aggregation and
  activation with the named owner.
- Never pipe an unchecked issue-body transform directly into `gh issue edit`.
  Build and validate the complete replacement first, then write it; a failed
  upstream transform can otherwise replace the issue body with empty input.
- Before claiming a provider boundary is not composed, trace the active
  configuration path through the app and composition roots, and distinguish a
  production wiring defect from missing local-verification parity.
- Tests of an isolated module do not prove production integration. Trace its
  callers from the Worker, Agent, or Workflow entry point before treating its
  policy or safety checks as implemented product behavior.
- The verification observer serves its own readiness response at `/health`.
  Test the product health contract with `test/wrangler.runtime.jsonc`, whose
  entry point is the production Worker.
- When a browser drive changes its expected request counts, update both the HTTP
  log validator and the final committed-state assertion. An expiry and refresh
  drive makes two presentations, while retained replay makes one.
- Provider evidence fixtures must use the adapter's complete wire payload. Gmail
  sends include explicit plain-text and primary-mailbox fields; test the actual
  live ledger selector as well as the final observation predicate.
- A provider effect creates a fresh Integration Session. Do not compare that
  Session with the retained browsing Session when binding send evidence; use the
  exact Action request, provider log, resource, and approved Connection identities.

- Run package Vitest configurations from the package directory. Passing a package
  config from the repository root leaves its relative test include paths rooted
  in the wrong directory and can report that no test files exist.
- Do not hold a deletion-fence semaphore while dispatching an approved Action
  that acquires the same fence. Track the outer dispatch so nested admission can
  proceed and deletion can still abort and drain both lifetimes. A Promise timeout
  only stops waiting; an already-started Action can execute after the caller fails.
- Preserve provider reconciliation ordering when adding an account-reset fence.
  Moving the PostgreSQL deletion check before guidance configuration caused
  previously local runtime fixtures to open background database connections.
  Check the durable reset marker before configuration and retain the existing
  deletion check immediately before submission.
- A missing facet registry row or canonical initialization identity does not prove
  account data erasure. Verify SQLite and KV are empty, then reopen the facet and
  prove fresh history and an open execution fence before restoring account access.
- A modal inside Settings content remains below the header's stacking context,
  even with a larger z-index. Use the shared portal and modal primitives, and
  verify that header controls outside the page cannot receive interaction while
  the confirmation is open.
- A completed source upload outlives the React component that presented it.
  Retain its opaque File ID across page lifecycles and recheck ownership before
  restoring the display. Reset the panel when the authenticated User changes.

- Executor SDK and plugin dependencies must resolve the same pinned Effect and
  Node-adapter peers. Pinning only the SDK and Effect allowed different SDK peer
  instances and incompatible plugin types; inspect the installed resolution.
- Admission guards need explicit authority in focused runtime fixtures that have no
  PostgreSQL application. Preserve the existing assertions and separately prove
  refusal reaches neither provider dispatch nor cost recording. Trace the installed
  streaming library before assuming an SDK error invokes its error hook; error
  frames and thrown transport failures can follow different paths.

- Check dispatch admission before reclaiming an expired provider attempt. A pause
  must return and retain its incurred evidence; an allowed retry must preserve
  the old immutable cost record before replacing the attempt row.
