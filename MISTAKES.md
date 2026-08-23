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
