# Oz model-quality evaluation and release-gate evidence

Research date: 2026-08-11

Source policy: current primary OpenAI, Anthropic, LangSmith, and NIST
documentation, plus accepted Oz decisions and local research

Access date for every external source: 2026-08-11

## Question and boundary

This note supports
[Define Oz model-quality evaluation and release gates](https://github.com/heyimcarlos/osfo/issues/165).
It asks how Oz can produce repeatable quality evidence for its complete launch
surface without mixing sampled judgments with system reliability.

The accepted production contract already fixes the boundary:

- Good Root Outcome uses reproducible journey assertions and excludes subjective
  model quality.
- Model quality must block a release through its own verdict. It does not enter
  production availability, Delivery, or infrastructure error-budget
  denominators.
- Oz must still meet the existing Evaluation Deadlines, cost gates, and system
  correctness gates when it runs model-quality tests.

## Executive answer

Oz needs a product-owned, versioned evaluation system with four separate forms
of evidence:

1. **Deterministic contract checks** for facts that have one safe answer, such
   as tool choice, tool arguments, citation support, output validity, memory
   provenance, approval boundaries, and forbidden external effects.
2. **Repeated model samples with calibrated model graders** for relevance,
   completeness, clarity, groundedness, and other open-ended qualities.
3. **Blinded human review** to define rubric examples, adjudicate ambiguous or
   safety-sensitive cases, and measure whether model graders still agree with
   human judgment.
4. **Production feedback triage** that turns reviewed, privacy-safe failures
   into a new corpus version. A raw user signal or online grader score is a lead,
   not a release label.

No single average can certify Oz. Each launch journey and each hard safety
invariant needs its own floor. A deterministic or safety failure cannot be
offset by a stronger helpfulness score elsewhere.

## 1. Corpus construction and versioning

OpenAI recommends task-specific tests that reflect production distributions,
use typical, edge, and adversarial cases, combine metrics with human judgment,
mine logs for new cases, and run evaluations on every change. It also warns
against generic benchmarks and datasets that do not represent production
traffic.
[OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
Anthropic gives the same core sequence: define specific and measurable success
criteria, build test cases, compare prompt versions, and complete final
validation before release.
[Anthropic success criteria and evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)

The Oz corpus should therefore contain:

- one stable release set for every launch journey;
- a sealed holdout set used to detect overfitting to the visible release set;
- a separate adversarial and safety set;
- a production-derived set that grows only from reviewed, minimized cases;
- metadata for journey, Plan, risk class, language or locale, input modality,
  context depth, expected use or refusal, and required grader set.

The aggregate sample should reflect the accepted Reference Workload Trace, but
aggregate weighting must not hide rare journeys. Ordinary conversation,
memory-informed response, file analysis, reminders, Gmail read and draft,
Research Report, Document Build, Scheduled Email, registration, billing,
safety, and data-rights work each need a separately reported result.

The accepted initial 600-case corpus is a starting corpus, not a permanent
sample size. Each journey and critical risk class needs its own minimum. Use an
initial run to estimate within-case variation and paired candidate-versus-
production discordance, then expand the independent case count until the
predeclared non-inferiority margin has enough power. Repeated outputs from one
case measure model variation but do not become independent cases.

Each case must package or identify the exact input and controlled fixtures:
Think history or Context Projection, Core Profile, canonical Memory Claims and
Knowledge Sources, local and Supermemory retrieval results, file bytes, tool
schemas, simulated provider responses, and expected observable properties.
Live web, Gmail, Supermemory, or mutable file-parser output is not a stable
reference. Use recorded or generated fixtures for release evaluation, then run
separate live-provider qualification.

Treat every corpus edit as a new immutable version. Retain the case diff, split,
source provenance, review state, and content digest. LangSmith is not the
selected Oz platform, but its first-party dataset contract is a useful
comparable: every add, edit, or delete creates a version, past versions are
read-only, and an evaluation can target a tagged version or split.
[LangSmith dataset versioning](https://docs.langchain.com/langsmith/manage-datasets)

## 2. Reproducible runs and graders

One evaluation manifest should freeze:

- source commit, prompt and policy digests, tool-schema versions, and Oz Plan
  Policy version;
- corpus version and split;
- exact managed route, provider, model ID, inference settings, and number of
  repetitions;
- grader code, rubric version, grader model ID and settings, and human-label
  set version;
- raw outputs, traces, per-case scores, failures, token use, latency, cost, UTC
  window, and artifact checksums.

Use a pinned provider model ID when the provider supports it. Anthropic states
that each current Claude model ID identifies one pinned model version, while
older convenience aliases can move to a later snapshot. It also notes that
serving infrastructure can still change observable behavior around fixed
weights.
[Anthropic model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)
The implication is that a fixed model ID is necessary but not sufficient.
Repeat samples and keep raw evidence.

Use deterministic graders first. Suitable checks include exact or structured
match, JSON Schema, citation-to-source support, required document sections,
PDF or DOCX render and open checks, Gmail recipient and body equality, valid
tool selection and arguments, no cross-Knowledge-Space retrieval, and no
protected effect without the exact approval. OpenAI describes string, text
similarity, model, and executable graders, and its agent guidance separates
output, tool-selection, and tool-argument evaluation.
[OpenAI graders](https://developers.openai.com/api/docs/guides/graders)

Use model graders only where code cannot express the rubric. Prefer pairwise
candidate-versus-production comparison or specific pass/fail criteria over an
open-ended score. Randomize response order, hide model identity, control length
where practical, and use clear examples for low, medium, and high quality.
OpenAI documents position and verbosity bias, and recommends agreement with
human labels before a model judge is scaled.
[OpenAI evaluator guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices#create-and-combine-different-types-of-evaluators)

For agent work, retain the whole observable trace. Trace grading can locate a
failure in orchestration, tool use, or the final answer instead of assigning one
black-box score to the response.
[OpenAI trace grading](https://developers.openai.com/api/docs/guides/trace-grading)
Gate required outcomes and hard invariants across tool choice, arguments,
retrieval, approvals, and external effects. Use trace grading to explain a
failure, but do not require one preferred trajectory when several trajectories
produce the same valid outcome.

## 3. Human calibration and safety-sensitive evaluation

Human reviewers should work from one versioned scorecard with concrete examples
at each score level and an explicit pass or fail boundary. Calibration cases
need independent, blinded labels and adjudication before they become grader
ground truth. The principal grader qualification is a confusion matrix against
those adjudicated labels, with one-sided confidence bounds on critical and
ordinary false passes and on false failures. Agreement, Cohen's kappa, or
Krippendorff's alpha remain supporting evidence because rare failures can make
one agreement statistic misleading. A grader change is itself a release change
and requires new calibration.

Safety and authority cases need a separate hard-blocking suite. It should cover
at least prompt injection through messages, files, email, memory, and web
content; fabricated sources; leakage across Knowledge Spaces; use of forgotten
or deleted memory; unsafe certainty; secret handling; destructive operations;
and every approval, ownership, Plan, allowance, and Integration Connection
boundary. Model judgment can propose an Action. It can never certify its own
authority or override the deterministic launch policy.

NIST says test sets, metrics, tools, deployment-like conditions, and results
should be documented. It also calls for regular assessment by people who were
not the front-line developers, and for post-deployment monitoring and user
input.
[NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)
The NIST Generative AI Profile adds structured feedback, field testing, and
red-teaming, and says these results should inform go or no-go and staged-release
decisions. It also says risks that exceed tolerance should be mitigated,
transferred, or avoided rather than averaged away.
[NIST Generative AI Profile](https://doi.org/10.6028/NIST.AI.600-1)

These sources support the gate structure. They do not supply Oz-specific score
numbers. Oz must predeclare its rubric floors, grader-agreement floor, sample
size, repetition count, non-regression margin, and confidence rule before it
observes candidate results.

## 4. Regression and release policy

Use two execution levels. A pull request runs affected deterministic tests plus
a representative, reproducibly sampled smoke corpus. A release candidate,
model or route change, and production promotion runs the complete repeated
Model Quality Gate. A scheduled complete run against current production
dependencies detects provider drift. Braintrust is only a comparable here, but
its first-party CLI makes the same evidence distinction: a sampled run is
non-final and a full-dataset run is final.
[Braintrust evaluation sampling](https://www.braintrust.dev/docs/reference/cli/eval#sampling-modes)

The complete gate should run when any of these change:

- model provider, model ID, route, sampling settings, or fallback;
- system prompt, skill, tool schema, approval presentation, or safety policy;
- Think context, compaction, Supermemory retrieval, Memory Claim selection, or
  Core Profile construction;
- file parsing, search, citation, Gmail, document-build, or Workflow behavior;
- Plan budget, maximum model steps, or cost-routing policy;
- corpus, rubric, deterministic grader, or model grader.

A candidate must pass absolute per-journey and safety floors and the declared
non-regression comparison with the current production release. Missing cases,
missing traces, an uncalibrated grader, or an unavailable required model are
MISSING, not PASS. A hard safety or authority failure is FAIL. Other quality
changes use the predeclared repeated-sample comparison and must not be judged
from one favorable run.

Promote through a bounded canary before broad rollout, then stop or roll back on
a hard violation or a confirmed quality regression. Keep model-quality verdicts
beside, but separate from, Bounded Beta Acceptance and Scale-Qualified Public
Launch. Both production levels need a current model-quality PASS.

Oz should own the manifest, cases, graders, raw outputs, and verdict logic even
if a hosted evaluator runs them. OpenAI currently states that its Evals platform
will become read-only on 2026-10-31 and shut down on 2026-11-30. This is direct
evidence against making a vendor evaluation product the sole evidence store.
[OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)

## 5. Production feedback loop

Use production evaluation for detection and corpus growth, not for rewriting
the release result. LangSmith's first-party evaluation model gives a useful
pattern: offline evaluation catches regressions on curated data; online
evaluation samples live traces; reviewed failures enter the offline dataset;
the fix is then tested before redeployment.
[LangSmith evaluation lifecycle](https://docs.langchain.com/langsmith/evaluation)

Oz should route explicit negative feedback, User corrections, repeated failed
Resolution Attempts, GM Summons, edited or canceled drafts, memory corrections,
support incidents, hard-invariant failures, and low online-grader results into
a human review queue. Record the sampling frame and sample count. Do not report
the sampled score as a full-traffic reliability ratio.

After review, create a minimized synthetic case when possible. If a real trace
is necessary, retain only the approved fields and preserve its deletion
lineage. User feedback, model-grader output, and support classification can all
be wrong. None becomes a gold label without review.

## Constraints from accepted Oz decisions

| Existing decision                                                                     | Constraint on model-quality evaluation                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Production SLO contract](https://github.com/heyimcarlos/osfo/issues/161)             | Quality stays separate from Good Root Outcome, latency SLOs, Delivery, and error budgets. Evaluation records latency and cost, but a good quality score cannot offset a system FAIL.                                                                                                                                                                                                                                              |
| [Launch capability and Plan contract](https://github.com/heyimcarlos/osfo/issues/157) | Test the exact Free and Adventurer routes within their model-step and cost limits. Report every capability separately. V1 has managed access only, no user model picker, and no Provider Connection.                                                                                                                                                                                                                              |
| [Oz Memory contract](https://github.com/heyimcarlos/osfo/issues/155)                  | Canonical Think and Oz records define truth. Supermemory results are derived and must map to current same-space sources or claims. Test first-message behavior, provider outage, stale generations, correction, conflict, forgetting, redaction, reset, compaction, and rebuild. Memory never grants authority.                                                                                                                   |
| Provider erasure qualification                                                        | A production-derived case, annotation, grader prompt, cached trace, and hosted-evaluator copy are additional deletion surfaces. Every retained case needs provenance and deletion propagation. Oz cannot promise permanent provider erasure while the R2 and Supermemory guarantees remain MISSING. See [Oz provider erasure and backup-retention guarantees](./oz-provider-erasure-and-backup-retention-guarantees-20260811.md). |
| Model provider connection decision                                                    | The earlier connection research is now future context. V1 evaluates Oz-managed routes. A later user-connected route needs its own provider, retention, model-version, safety, cost, and quality qualification. See [Oz model provider connections](./oz-model-provider-connections-20260808.md).                                                                                                                                  |
| Cloudflare and Think foundation                                                       | Do not make LangSmith, OpenAI Evals, or another hosted evaluator part of Oz runtime authority. Use them only as replaceable execution or analysis tools around Oz-owned artifacts.                                                                                                                                                                                                                                                |

## Decision points that remain for the ticket

The primary sources and local contracts narrow the choice, but they do not
settle these numbers and procedures:

1. The power target, initial per-journey case minimums, and predeclared expansion
   rule for paired candidate-versus-production comparisons.
2. The absolute quality floors and paired non-regression rule.
3. The confusion-matrix confidence method and minimum model-grader calibration
   sample for critical and ordinary errors.
4. Which safety failures have zero tolerance, and which require human
   adjudication before the verdict.
5. The canary size, observation window, rollback rule, and production review
   sample.
6. The exact privacy, consent, retention, and deletion policy for real traces
   admitted into evaluation.
