# Pstack model-diverse code review

Date: 2026-08-25  
Official reference: [`cursor/plugins` at `bdf7aa355337897f167153e05069aca505dae17c`](https://github.com/cursor/plugins/tree/bdf7aa355337897f167153e05069aca505dae17c/pstack)

## Recommendation

Adopt the useful part of pstack, but fit it to Osfo's existing review contract.

Every ticket should keep one writable owner. At each merge-ready head, spawn two
fresh, read-only reviewers in parallel. Give Standards and Spec to different
Codex model IDs, preserve their reports as separate axes, send accepted findings
back to the same owner, and repeat both reviews on every new head SHA. Merge
without another human checkpoint once both axes are clean, the relevant gates
pass, and user-visible work has live verification evidence.

Do not run pstack's four-model `/interrogate` panel on every ordinary ticket.
Pstack itself warns that review ceremony can cost more than the work. Add a third
model only for a disputed or high-risk finding. Reserve a larger panel for a
contested design or a change whose consequences are expensive to reverse.

This is a policy worth piloting, not a proven ranking of Codex models. The source
contains no benchmark showing that its default model assignments find more bugs,
and no first-party evidence reviewed here proves that the Codex models available
to this session have statistically independent blind spots.

## Method

The official repository was already present at `.reference/cursor-plugins`. I
fetched and fast-forwarded it from its configured
`https://github.com/cursor/plugins.git` remote, expanded the sparse checkout to
the complete `pstack` tree, and inspected all 156 tracked files. The reference
worktree was clean at the commit above. I searched the skills, playbooks, agents,
scripts, tests, and guide, then read the files that define model routing, review,
verification, orchestration, and review evidence.

All `pstack/...:Lx-Ly` citations below refer to that pinned commit. Direct links
use immutable GitHub blob URLs. The relevant workflow history includes:

| Commit                                                                                                                          | Change                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`939812915e8a1c2359b0ea8d93fee7c29c41f60e`](https://github.com/cursor/plugins/commit/939812915e8a1c2359b0ea8d93fee7c29c41f60e) | Added the multi-model code-quality lens to Interrogate.                        |
| [`6605d7adc3d4733b87273158c4cc49ae184409ab`](https://github.com/cursor/plugins/commit/6605d7adc3d4733b87273158c4cc49ae184409ab) | Added per-role model configuration.                                            |
| [`e1007b141f5574a340460414a23f5e18f56c3121`](https://github.com/cursor/plugins/commit/e1007b141f5574a340460414a23f5e18f56c3121) | Set the initial diverse default panels.                                        |
| [`d45ad028b7d50fca8550a33e7b40842e67fea284`](https://github.com/cursor/plugins/commit/d45ad028b7d50fca8550a33e7b40842e67fea284) | Expanded the panels to four models.                                            |
| [`99559f2f52047978602ef365589275831e76af07`](https://github.com/cursor/plugins/commit/99559f2f52047978602ef365589275831e76af07) | Added the current Orchestrate workflow and its different-family verifier rule. |
| [`b047069f4f3a73e87dd1f11f7913386d25876b91`](https://github.com/cursor/plugins/commit/b047069f4f3a73e87dd1f11f7913386d25876b91) | Added the autopilot fix and fresh-verdict loop.                                |

The main local evidence paths are:

| Local source at `bdf7aa355337897f167153e05069aca505dae17c`                                 | Evidence                                                          |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `.reference/cursor-plugins/pstack/skills/setup-pstack/SKILL.md:20-57`                      | Per-role models and configurable panel counts.                    |
| `.reference/cursor-plugins/pstack/skills/interrogate/SKILL.md:7-112`                       | Four-reviewer panel, shared prompt, synthesis, and lead verdict.  |
| `.reference/cursor-plugins/pstack/skills/interrogate/references/lead-judgment.md:3-58`     | False-positive handling and lead judgment.                        |
| `.reference/cursor-plugins/pstack/skills/poteto-mode/playbooks/orchestrate.md:15-21,87-93` | Different-family verification and the exact-SHA ledger rule.      |
| `.reference/cursor-plugins/pstack/skills/poteto-mode/playbooks/autopilot-full.md:5-10`     | Parallel owners, swarm verdict, fix-forward, and fresh re-review. |
| `.reference/cursor-plugins/pstack/skills/poteto-mode/scripts/orch/store.ts:1331-1371`      | Exact `pr + sha` lookup implementation.                           |
| `.reference/cursor-plugins/pstack/skills/poteto-mode/scripts/orch/orch.test.ts:259-303`    | Ledger behavior test.                                             |

## What pstack actually does

### It routes work by model role

Pstack intentionally configures models by role. It does not have one global
implementer model and one global reviewer model.

Its default implementation choices are Grok for features and refactors, Sol for
bug fixes, performance work, and hillclimbs, and Fable for judgment, prose, or
the hardest vaguely specified tasks. The default review panels contain Fable,
Sol, Grok, and Opus. The model lists are user-configurable, and their length sets
the panel size. See
[`pstack/skills/setup-pstack/SKILL.md:L20-L57`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/setup-pstack/SKILL.md#L20-L57),
[`pstack/skills/poteto-mode/SKILL.md:L87-L93`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/poteto-mode/SKILL.md#L87-L93),
and
[`pstack/README.md:L23-L30`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/README.md#L23-L30).

Reasoning effort is part of the configuration. The default slugs encode `max`
or `xhigh`, and the unresolved-model fallback prefers the highest available
reasoning tier in the same family. See
[`pstack/skills/interrogate/SKILL.md:L36-L50`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/interrogate/SKILL.md#L36-L50).

There is one strict implementer-versus-reviewer separation rule. Orchestrate
requires a unit's dedicated verifier to use a different model family from its
worker. It applies that separate verifier only when verification is expensive,
judgment-heavy, or high risk. A cheap command stays with the worker and the
coordinator spot-checks its receipt. See
[`pstack/skills/poteto-mode/playbooks/orchestrate.md:L15-L21`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/poteto-mode/playbooks/orchestrate.md#L15-L21)
and
[`pstack/skills/poteto-mode/playbooks/orchestrate.md:L87-L93`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/poteto-mode/playbooks/orchestrate.md#L87-L93).

That rule does not mean the Interrogate panel must exclude the model that wrote
the code. The default panel includes the implementation defaults, and the source
has no exclusion check. Pstack obtains diversity from the whole panel, not from
a strict writer-model blacklist.

### The code-review panel has four default reviewers and one lead

`/interrogate` is pstack's direct multi-model code review:

1. The parent fixes the review scope and states the author's intent.
2. It spawns one read-only general-purpose reviewer for each configured model in
   one tool message. The default count is four.
3. Every reviewer receives the same intent, diff or files, rubric, and
   code-quality lens. Pstack rejects assigned personas as the source of
   diversity. The model difference is meant to provide the independent signal.
4. After all results return, the parent deduplicates findings, records agreement
   and disagreement, and distinguishes consensus from lone-model findings.
5. The parent becomes lead reviewer and classifies every finding as `Act on`,
   `Consider`, `Noted`, or `Dismissed`.

The source is explicit about the four defaults, read-only mode, and shared
prompt at
[`pstack/skills/interrogate/SKILL.md:L34-L60`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/interrogate/SKILL.md#L34-L60).
Its synthesis and lead phases are at
[`pstack/skills/interrogate/SKILL.md:L62-L89`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/interrogate/SKILL.md#L62-L89).

The same prompt controls a confound. If reviewers get different personas or
different questions, agreement and disagreement may reflect the prompts rather
than the models. It also creates a shared framing risk because all reviewers can
miss something omitted from that one prompt or diff.

Interrogate reports only. It says not to apply changes automatically. The lead
verdict is the artifact. See
[`pstack/skills/interrogate/SKILL.md:L7-L11`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/interrogate/SKILL.md#L7-L11).

### Verification has a separate fix and re-review loop

Pstack's autonomous PR workflow supplies the mutation loop that Interrogate
does not. One owner carries a PR. At the merge-ready head SHA, the root fans out
parallel, independent verifiers. The lanes rerun gates, exercise the important
behavior on the real surface, and audit the receipts and diff without trusting
the PR body. Findings return to the owner for a fix. The new head gets a fresh
swarm and verdict. See
[`pstack/skills/poteto-mode/playbooks/autopilot-full.md:L5-L10`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/poteto-mode/playbooks/autopilot-full.md#L5-L10).

The verifier count in this workflow is not fixed. The Swarm skill derives `N`
from the requested shape, launches all workers in parallel, and aggregates their
terminal reports. See
[`pstack/skills/swarm/SKILL.md:L20-L42`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/swarm/SKILL.md#L20-L42).

Shipping uses a simpler topology. It runs one independent verifier per PR, then
lands only the contiguous passing run from the bottom of the stack. The verifier
must not be the author. See
[`pstack/skills/poteto-mode/playbooks/shipping.md:L3-L10`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/poteto-mode/playbooks/shipping.md#L3-L10).

These are adjacent review roles, not one mandatory pipeline:

| Role                             |                      Default count | Mutates code | Purpose                                                                              |
| -------------------------------- | ---------------------------------: | ------------ | ------------------------------------------------------------------------------------ |
| Ticket owner or worker           |               One per ticket or PR | Yes          | Implements, fixes, and produces proof.                                               |
| Interrogate adversarial reviewer |  Four, configurable by list length | No           | Tries to break the diff with one shared rubric.                                      |
| Interrogate lead                 |             The parent coordinator | No           | Filters noise and records the agreement map.                                         |
| Orchestrate dedicated verifier   |               Zero or one per unit | No           | Independently verifies costly or risky units.                                        |
| Autopilot swarm verifier         |                   Configurable `N` | No           | Checks gates, live behavior, receipts, and diff.                                     |
| Shipping verifier                |                         One per PR | No           | Produces a pre-merge verdict for the current code.                                   |
| Comment Sicko                    |       One when `/no-comments` runs | No           | Reviews comments with a narrow specialist policy. The parent applies accepted edits. |
| Trail reviewer                   | One, from a different model family | No           | Audits the decision log and transcript before handoff.                               |

The specialized comment reviewer is defined at
[`pstack/agents/comment-sicko.md:L1-L32`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/agents/comment-sicko.md#L1-L32).
The different-family trail review is defined at
[`pstack/skills/show-me-your-work/SKILL.md:L65-L74`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/show-me-your-work/SKILL.md#L65-L74).

Pstack also uses model panels outside branch review. How critique mode runs four
parallel architectural critics and then lead judgment. Arena defaults to four
parallel candidates followed by one read-only cross-judge. Reflect runs three
parallel transcript reviewers followed by one synthesizer. See
[`pstack/skills/how/SKILL.md:L102-L134`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/how/SKILL.md#L102-L134),
[`pstack/skills/arena/SKILL.md:L22-L67`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/arena/SKILL.md#L22-L67),
and
[`pstack/skills/reflect/SKILL.md:L21-L57`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/reflect/SKILL.md#L21-L57).

## How it manages review quality

### Independence and context isolation

Pstack creates separate, read-only subagents for Interrogate and sends them the
same packaged diff and context. The lead framework says those reviewers see a
slice of the codebase and a one-paragraph intent, while the parent retains the
full conversation context. This is practical context isolation, but the source
does not claim a cryptographic or runtime isolation boundary. See
[`pstack/skills/interrogate/references/lead-judgment.md:L3-L14`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/interrogate/references/lead-judgment.md#L3-L14).

Writable work uses a stronger boundary. Arena candidates and Swarm workers get
separate worktrees, branches, directories, or output paths. See
[`pstack/skills/arena/SKILL.md:L22-L37`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/arena/SKILL.md#L22-L37)
and
[`pstack/skills/swarm/SKILL.md:L20-L34`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/swarm/SKILL.md#L20-L34).

### Correlated blind spots

Pstack's control is model diversity plus independent agreement. It treats a
finding from at least two models as stronger evidence, while a lone-model
finding receives less weight. It does not measure correlation between models,
training data, prompts, or tool behavior. Its statement that models have
different blind spots is a design premise, not a result established by tests in
the repository. See
[`pstack/skills/interrogate/SKILL.md:L7-L10`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/interrogate/SKILL.md#L7-L10)
and
[`pstack/skills/interrogate/SKILL.md:L62-L70`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/interrogate/SKILL.md#L62-L70).

Consensus is useful triage evidence, not proof. The lead framework keeps
single-model security and correctness findings under scrutiny when the other
models miss them. See
[`pstack/skills/interrogate/references/lead-judgment.md:L43-L56`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/interrogate/references/lead-judgment.md#L43-L56).

### Disagreement and false positives

The synthesizer records direct disagreements instead of averaging them away.
The lead then checks findings against the full call path and project context.
The source calls preference-only rewrites a common false positive, warns that
adversarial reviewers inflate nits, rejects unreachable hypotheticals, and
dismisses suggestions that conflict with known constraints. It retains a
`Dismissed` section so the operator can reverse the lead's judgment. See
[`pstack/skills/interrogate/references/lead-judgment.md:L16-L41`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/interrogate/references/lead-judgment.md#L16-L41)
and
[`pstack/skills/interrogate/references/lead-judgment.md:L54-L58`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/interrogate/references/lead-judgment.md#L54-L58).

### Cost and latency

Pstack parallelizes review and makes panel length configurable. It also tells
the coordinator to scale ceremony to risk. The Orchestrate playbook records one
case where its full process performed much worse than a plain agent on a small
job, says every gate costs coordinator time, and rejects a dedicated verifier
whose only task would be rerunning one cheap command. See
[`pstack/skills/poteto-mode/playbooks/orchestrate.md:L1-L5`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/poteto-mode/playbooks/orchestrate.md#L1-L5)
and
[`pstack/skills/poteto-mode/playbooks/orchestrate.md:L87-L91`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/poteto-mode/playbooks/orchestrate.md#L87-L91).

The repository has no dollar budget, token budget, review-latency target, model
benchmark, or measured precision and recall for findings. Parallel execution
reduces wall-clock delay relative to serial reviewers, but the source does not
quantify that gain.

### Exact-SHA evidence

Pstack's orchestrator ledger keys each verdict by PR number and head SHA. A new
SHA voids the verdict and requires verification again. The ledger records the
verdict, evidence path, verifier, and timestamp. See
[`pstack/skills/poteto-mode/playbooks/orchestrate.md:L87-L93`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/poteto-mode/playbooks/orchestrate.md#L87-L93).

This is implemented, not just stated in prose. The store looks up an exact
`pr + sha` pair and returns `NOT-VERIFIED` when no row matches. See
[`pstack/skills/poteto-mode/scripts/orch/store.ts:L1331-L1371`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/poteto-mode/scripts/orch/store.ts#L1331-L1371).
The test covers missing, recorded, replaced, and checked ledger verdicts at
[`pstack/skills/poteto-mode/scripts/orch/orch.test.ts:L259-L303`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/poteto-mode/scripts/orch/orch.test.ts#L259-L303).

Autopilot also pins the swarm verdict to the merge-ready head. A new head gets a
fresh swarm unless a shipping-time patch-ID comparison proves that the patch did
not change. See
[`pstack/skills/poteto-mode/playbooks/autopilot-full.md:L8-L10`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/poteto-mode/playbooks/autopilot-full.md#L8-L10)
and
[`pstack/skills/poteto-mode/playbooks/shipping.md:L7-L10`](https://github.com/cursor/plugins/blob/bdf7aa355337897f167153e05069aca505dae17c/pstack/skills/poteto-mode/playbooks/shipping.md#L7-L10).

Interrogate itself is weaker here. It reviews `git diff main...HEAD` or the
current files but does not capture the resolved base and head SHAs in its
verdict. Exact-SHA invalidation comes from the orchestration and shipping
playbooks, not the Interrogate skill. Osfo should combine the two.

## Essential ideas and Cursor-specific mechanics

| Keep for Osfo                                         | Reason                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| One writable owner per ticket                         | Fixes stay coherent and reviewers stay independent from authorship.                            |
| Fresh, read-only review agents                        | A new context cannot defend choices it made while implementing.                                |
| Identical immutable diff, intent, and evidence inputs | Agreement is interpretable only when reviewers saw the same change.                            |
| Different model IDs for independent review            | This is a cheap hedge against one model's recurring miss pattern, subject to a measured pilot. |
| Separate Standards and Spec axes                      | A standards pass must not hide a spec failure, or the reverse.                                 |
| Lead validation with explicit dismissals              | Adversarial review produces useful catches and noise. Both need an evidence trail.             |
| Fix-forward through the original owner                | One agent retains ticket ownership while reviewers remain read-only.                           |
| Verdicts pinned to exact SHA                          | Every code change invalidates the old review evidence.                                         |
| Risk-scaled reviewer count                            | Four reviewers on a mechanical change are usually wasted work.                                 |
| Real-surface verification for behavior                | Static review and a green build do not prove the user journey.                                 |

The following mechanics belong to Cursor or pstack and should not cross into
the Codex policy unchanged:

- Cursor `Task`, `generalPurpose`, `readonly`, cloud agents, and local versus
  cloud environment selection.
- `.cursor/rules/pstack-models.mdc`, Cursor model slugs, and pstack's default
  Fable, Sol, Grok, and Opus assignments.
- Cursor `/loop`, its agent store, and the `poteto-agent` wrapper.
- Graphite `gt`, stack restacks, merge-when-ready, and patch-ID reuse.
- Bugbot and `cursor-team-kit` control skills.
- The four-reviewer default as a universal review count. Pstack does not use it
  universally either.

## Proposed Codex-native policy

### Ownership and sequence

1. The coordinator selects one ticket from the Wayfinder. One implementer owns
   its isolated worktree through implementation and every review fix.
2. The implementer reports a clean worktree, exact base SHA, exact head SHA,
   commands run, and user-visible verification receipts where applicable.
3. The coordinator resolves and freezes both SHAs before review. Review agents
   inspect `git diff <base-sha>...<head-sha>`, not moving branch names.
4. The coordinator launches Standards and Spec in parallel with fresh contexts
   and different model IDs. Both are read-only.
5. The current two-axis skill remains authoritative. Standards receives root and
   package `AGENTS.md`, the smell baseline, and the TypeScript and Effect skills
   when the diff uses them. Spec receives the issue, linked spec and ADRs, and
   acceptance criteria. The coordinator reports both axes separately without
   allowing one to cancel the other.
6. The coordinator validates each finding within its own axis. A dismissal needs
   a concrete code path, test, source rule, or spec citation. It then sends the
   accepted set back to the same implementer.
7. Any fix creates a new head SHA. Spawn fresh Standards and Spec agents and run
   both axes again. Do not resume the prior reviewers and do not carry forward a
   clean verdict from the old SHA.
8. For user-visible behavior, a fresh verifier drives `.agents/skills/verify-osfo`
   at the reviewed SHA. Registration, SMS OTP, channel linking, and cleanup use
   run-owned local state and leave evidence.
9. When both axes are clean, required repository gates pass, and live evidence is
   present, the coordinator opens and merges the PR under the user's standing
   merge authorization. It then updates the Wayfinder state and selects the next
   ticket.

This does not increase the ticket queue. Reviewers are lanes within one ticket,
not owners of additional tickets. Keep one active ticket by default and never
exceed three active ticket owners.

The local source for that separation is
`/home/ren/.codex/skills/code-review/SKILL.md:6-11,58-78`. It requires parallel
Standards and Spec agents and forbids merging or reranking their reports.

### Starting reviewer matrix

The current Codex collaboration tool exposes only the model overrides named in
this table. The role assignments are a controlled starting point. They are not
claims that one model is intrinsically better at a named axis.

| Lane                 | Model           | Reasoning | Context                                                                                                                              |
| -------------------- | --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Implementer          | `gpt-5.6-sol`   | `high`    | Full ticket, repository context, writable worktree. Raise to `xhigh` for cross-package state, concurrency, or trust-boundary work.   |
| Standards reviewer   | `gpt-5.5`       | `high`    | Fresh read-only context. Exact diff plus repository rules and applicable TypeScript and Effect skills.                               |
| Spec reviewer        | `gpt-5.4`       | `high`    | Fresh read-only context. Exact diff plus issue, specs, ADRs, and acceptance criteria.                                                |
| Third reviewer       | `gpt-5.6-terra` | `xhigh`   | Fresh targeted context for one disputed or high-risk finding. It must verify or disprove the finding, not rerun a vague full review. |
| Cheap receipt runner | `gpt-5.6-luna`  | `medium`  | Optional. Reruns deterministic commands and records output. It does not replace a judgment review or live browser verifier.          |

Using `gpt-5.5` and `gpt-5.4` for the two default axes keeps both away from the
writer's model ID and from each other. That gives a cleaner pilot than assigning
two `gpt-5.6-*` variants and calling them independent families. The source
reviewed here does not establish how correlated any of these Codex models are.

### Third-model triggers

Escalate to the third reviewer when any one of these holds:

- Standards and Spec make incompatible claims about the same execution path.
- Either axis finds a plausible correctness or security defect with a concrete
  path, even if the other reviewer is silent.
- The change touches authentication, authorization, billing, user data,
  migrations, provider authority, or irreversible external effects.
- Static review and live verification disagree.
- The same ticket has needed two fix and review rounds and the next finding would
  force another structural change.
- The implementation crosses a package ownership or trust boundary and a
  finding depends on which side owns the invariant.

Do not use a third reviewer merely to break a vote. Give it the disputed claim,
the source evidence from both reviewers, the exact diff, and a falsifiable
question. The coordinator still decides and records the disproof or accepted
fix within the original axis.

### Review record

Record one immutable review block in the issue or PR for each head:

```text
ticket: #<number>
base_sha: <40-char SHA>
head_sha: <40-char SHA>
standards: <model> / <reasoning> / <clean or findings> / <evidence path>
spec: <model> / <reasoning> / <clean or findings> / <evidence path>
third_review: <none or model / reasoning / targeted verdict>
gates: <exact commands and outcomes>
live_verification: <run id and evidence path, or n/a with reason>
decision: <fix-forward, blocked, or merge>
```

Treat any new head SHA as unreviewed. Osfo should not adopt pstack's patch-ID
reuse until a local tool implements and tests that exception. Strict invalidation
is simpler for the current one-ticket flow.

### Pilot and adjustment

Run the matrix for ten merged tickets before treating the assignment as settled.
For each reviewer and axis, record:

- actionable findings confirmed by a test, runtime evidence, or source rule;
- findings dismissed with a concrete disproof;
- issues found only after merge;
- elapsed review time and the number of fix rounds.

Keep the two-axis prompt and evidence scope fixed during the pilot. Changing the
model and prompt together would make the result uninterpretable. After ten
tickets, retain, swap, or simplify the matrix based on observed unique catches,
false positives, post-merge escapes, and delay. Do not infer model quality from
finding count alone because an aggressive reviewer can manufacture more noise.

## Unsupported assumptions and limits

- Pstack says different models have different strengths and blind spots, but its
  repository contains no comparative eval, precision measure, or defect-escape
  study supporting the named defaults.
- A model slug's `max` or `xhigh` suffix proves the configured reasoning label.
  It does not quantify effort or prove that more effort improves code review.
- Separate subagents, read-only instructions, and different model IDs improve
  procedural independence. They do not prove statistical independence.
- The same prompt makes reviewers comparable but can induce the same omission in
  every reviewer.
- Agreement across models raises confidence in pstack's policy. It is not a
  correctness proof. One concrete security defect can outweigh four silent
  reviewers.
- Pstack does not define a fixed verifier count for Autopilot swarms.
- Interrogate does not itself pin the review to an exact SHA or implement a fix
  loop. Those guarantees come from other pstack playbooks.
- The orchestration ledger stores a free-form verifier string, not separate model,
  reasoning, rubric-version, or prompt-version fields.
- The Markdown skills instruct agents to follow these workflows. The repository
  has tests for the exact-SHA ledger and PR watcher, but no automated test of
  Interrogate's fan-out, reviewer effectiveness, or model independence.
- The model matrix above uses only overrides exposed in this Codex session on
  2026-08-25. Availability and model descriptions can change. Re-read the active
  collaboration tool contract before spawning a future panel.
