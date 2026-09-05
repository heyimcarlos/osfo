# Mistakes

Record mistakes that can affect the current Osfo implementation. Keep each entry
short, specific, and actionable.

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
