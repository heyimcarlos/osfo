# Osfo policy

Stable contracts live here. Product truth lives in `CONTEXT.md`, durable decisions in `docs/adr/`, and active work in GitHub Issues.

## Verification and evidence

<add verification and evidence requirements here>

example: 
- Run `bun run format` before a PR and include only files owned by the branch.

## Collaboration Notes

- The user uses speech-to-text; infer likely intent from odd wording, ask only when needed.
- Code is cheap to write: no time estimates, implementation time isn't a blocker.
- Never use em-dashes anywhere. Use commas, colons, parentheses, or separate sentences.

## Reference Repositories

Repos in `.reference` (rig, codex, …) are available for patterns. Clone a given Git URL into `.reference` and pull latest before using it.

## Engineering boundaries

- Prefer correctness and predictable behavior over short-term convenience.
- Preserve runtime behavior during lint, typing, or test structure changes.
- Use public package exports; never cross package boundaries with relative
  imports.
- Extract shared logic only for genuinely shared behavior. Avoid generic
  abstractions for one-off duplication.
- Public PRs, commits, generated files, and documentation contain no private
  names, internal context, customer-derived data, or AI attribution.

## Package Ownership

<add package ownership requirements here>

- `crates/`

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical labels unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo: root `CONTEXT.md` and `docs/adr/`. See
`docs/agents/domain.md`.

Note mistakes in MISTAKES.md, missing context or tools in DESIRES.md, and env learnings in LEARNINGS.md.

### Other

Osfo v1 is a deliverable for an interview exercise. The instructions are in .take-home/instructions.pdf. We must highlight/document important decisions, and any evidence that might be useful for the presentation of v1. Use the .take-home/CHECKPOINTS.md file to track progress and decisions. This will be used to generate the final report/presentation.
