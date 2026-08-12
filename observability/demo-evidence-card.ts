import { Data, Effect, Schema } from "effect";

const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const UtcTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u),
);
const OffsetTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u),
);

const LoadScenarioSchema = Schema.Struct({
  benchmark_id: Schema.String,
  lane: Schema.String,
  started_at: UtcTimestampSchema,
  offer_ended_at: UtcTimestampSchema,
  ended_at: UtcTimestampSchema,
  rate_per_second: Schema.Number,
  duration_seconds: Schema.Number,
  count: Schema.Number,
  principal_count: Schema.optionalKey(Schema.Number),
});

const ReceiptAuditSchema = Schema.Struct({
  benchmark_id: Schema.String,
  expected_incoming: Schema.Number,
  accepted_incoming: Schema.Number,
  authoritative_agent_runs: Schema.Number,
  succeeded_agent_runs: Schema.Number,
  good_root_outcomes: Schema.Number,
  nonterminal_agent_runs: Schema.Number,
  duplicate_terminal_commits: Schema.Number,
  unfinished_agent_run_attempts: Schema.Number,
  unfinished_model_call_attempts: Schema.Number,
  verdict: Schema.Literal("PASS"),
});

const CallerSummarySchema = Schema.Struct({
  count: Schema.Number,
  outcomes: Schema.Array(
    Schema.Struct({
      outcome: Schema.String,
      count: Schema.Number,
    }),
  ),
  latency_ms: Schema.Struct({
    count: Schema.Number,
    p99: Schema.Number,
    max: Schema.Number,
  }),
});

const ReceiptSloSchema = Schema.Struct({
  run: Schema.String,
  total: Schema.Number,
  over_threshold: Schema.Number,
  within_threshold_ratio: Schema.Number,
  source_manifest_sha256: Sha256Schema,
});

const MatrixCellSchema = Schema.Struct({
  matrix_cell: Schema.String,
  workload: Schema.Struct({
    rate_per_second: Schema.Number,
    duration_seconds: Schema.Number,
    commands: Schema.Number,
    principals: Schema.Number,
  }),
  receipt: Schema.Struct({
    offered: Schema.Number,
    accepted: Schema.Number,
    unknown: Schema.Number,
    within_1_second_ratio: Schema.Number,
    p99_ms: Schema.Number,
  }),
  reconciliation: Schema.Struct({
    verdict: Schema.Literal("PASS"),
    good_root_outcomes: Schema.Number,
    authoritative_agent_runs: Schema.Number,
    succeeded_agent_runs: Schema.Number,
  }),
  pass: Schema.Boolean,
  evidence: Schema.Struct({ lane_sha256sums_sha256: Sha256Schema }),
});

const MatrixSummarySchema = Schema.Struct({
  cells: Schema.Record(Schema.String, MatrixCellSchema),
});

const DeliveryScenarioSchema = Schema.Struct({
  benchmark_id: Schema.String,
  lane: Schema.String,
  started_at: UtcTimestampSchema,
  offer_ended_at: UtcTimestampSchema,
  ended_at: UtcTimestampSchema,
  rate_per_second: Schema.Number,
  duration_seconds: Schema.Number,
  count: Schema.Number,
  worker_fixed_instances: Schema.Number,
});

const DeliveryAuditSchema = Schema.Struct({
  benchmark_id: Schema.String,
  expected: Schema.Number,
  total: Schema.Number,
  succeeded: Schema.Number,
  canceled: Schema.Number,
  nonterminal: Schema.Number,
  duplicate_terminals: Schema.Number,
  delivery_to_claim_ms: Schema.Struct({ p99: Schema.Number }),
  offer_ended_at: OffsetTimestampSchema,
  last_completed_at: OffsetTimestampSchema,
});

const WorkerLossScenarioSchema = Schema.Struct({
  benchmark_id: Schema.String,
  lane: Schema.String,
  started_at: UtcTimestampSchema,
  ended_at: UtcTimestampSchema,
});

const WorkerLossAuditSchema = Schema.Struct({
  benchmark_id: Schema.String,
  expected_incoming: Schema.Number,
  accepted_incoming: Schema.Number,
  authoritative_agent_runs: Schema.Number,
  succeeded_agent_runs: Schema.Number,
  good_root_outcomes: Schema.Number,
  nonterminal_agent_runs: Schema.Number,
  duplicate_terminal_commits: Schema.Number,
  unfinished_agent_run_attempts: Schema.Number,
  unfinished_model_call_attempts: Schema.Number,
  delivery_attempts: Schema.Number,
  delivery_attempt_outcomes: Schema.Record(Schema.String, Schema.Number),
  verdict: Schema.Literal("PASS"),
});

export const POST_RUN_DISCLAIMER =
  "post-run render from sealed records, not an in-run screen capture";

export interface EvidenceCardModel {
  readonly id: string;
  readonly title: string;
  readonly runId: string;
  readonly status: "PASS" | "FAIL";
  readonly timestamps: {
    readonly startedAt: string;
    readonly offerEndedAt?: string;
    readonly endedAt: string;
  };
  readonly workload: string;
  readonly resultLines: ReadonlyArray<string>;
  readonly sourceManifestSha256: string;
  readonly disclaimer: typeof POST_RUN_DISCLAIMER;
}

export class EvidenceCardError extends Data.TaggedError("EvidenceCardError")<{
  readonly operation: string;
}> {}

const decode = <A>(schema: Schema.Decoder<A>, value: Schema.Json, operation: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new EvidenceCardError({ operation })),
  );

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});
const formatPercent = (ratio: number) => `${(ratio * 100).toFixed(8)}%`;

const matchingBenchmark = (left: string, right: string) =>
  left === right
    ? Effect.void
    : Effect.fail(new EvidenceCardError({ operation: "match benchmark identifiers" }));

export const buildMatrixCardModel = (input: {
  readonly cell: string;
  readonly sourceManifestSha256: string;
  readonly scenario: Schema.Json;
  readonly summary: Schema.Json;
}) =>
  Effect.gen(function* () {
    const scenario = yield* decode(LoadScenarioSchema, input.scenario, "decode matrix scenario");
    const summary = yield* decode(MatrixSummarySchema, input.summary, "decode matrix summary");
    const sourceManifestSha256 = yield* decode(
      Sha256Schema,
      input.sourceManifestSha256,
      "decode matrix source manifest checksum",
    );
    const cell = summary.cells[input.cell];
    if (cell === undefined) {
      return yield* new EvidenceCardError({ operation: `find matrix cell ${input.cell}` });
    }
    if (
      cell.matrix_cell !== scenario.lane ||
      cell.evidence.lane_sha256sums_sha256 !== sourceManifestSha256 ||
      cell.workload.rate_per_second !== scenario.rate_per_second ||
      cell.workload.duration_seconds !== scenario.duration_seconds ||
      cell.workload.commands !== scenario.count ||
      cell.workload.principals !== scenario.principal_count
    ) {
      return yield* new EvidenceCardError({
        operation: `match matrix cell ${input.cell} authority`,
      });
    }

    return {
      id: `matrix-${input.cell.toLowerCase()}`,
      title: `Final us-east4 matrix cell ${input.cell}`,
      runId: scenario.benchmark_id,
      status: cell.pass ? ("PASS" as const) : ("FAIL" as const),
      timestamps: {
        startedAt: scenario.started_at,
        offerEndedAt: scenario.offer_ended_at,
        endedAt: scenario.ended_at,
      },
      workload: `${integer.format(scenario.count)} commands at ${integer.format(scenario.rate_per_second)}/s for ${integer.format(scenario.duration_seconds)}s, ${integer.format(cell.workload.principals)} principals`,
      resultLines: [
        `${integer.format(cell.receipt.accepted)} accepted, ${integer.format(cell.receipt.unknown)} caller unknown`,
        `${formatPercent(cell.receipt.within_1_second_ratio)} within 1s, receipt p99 ${decimal.format(cell.receipt.p99_ms)} ms`,
        `${integer.format(cell.reconciliation.good_root_outcomes)} Good Root Outcomes, ${integer.format(cell.reconciliation.succeeded_agent_runs)} / ${integer.format(cell.reconciliation.authoritative_agent_runs)} AgentRuns succeeded`,
        `Accepted-work reconciliation ${cell.reconciliation.verdict}; admission ${cell.pass ? "PASS" : "FAIL"}`,
      ],
      sourceManifestSha256,
      disclaimer: POST_RUN_DISCLAIMER,
    } satisfies EvidenceCardModel;
  });

export const buildReceiptCardModel = (input: {
  readonly id: string;
  readonly title: string;
  readonly sourceManifestSha256: string;
  readonly scenario: Schema.Json;
  readonly audit: Schema.Json;
  readonly callerSummary: Schema.Json;
  readonly receiptSlo: Schema.Json | undefined;
}) =>
  Effect.gen(function* () {
    const scenario = yield* decode(LoadScenarioSchema, input.scenario, "decode receipt scenario");
    const audit = yield* decode(ReceiptAuditSchema, input.audit, "decode receipt audit");
    const caller = yield* decode(CallerSummarySchema, input.callerSummary, "decode caller summary");
    const sourceManifestSha256 = yield* decode(
      Sha256Schema,
      input.sourceManifestSha256,
      "decode receipt source manifest checksum",
    );
    yield* matchingBenchmark(scenario.benchmark_id, audit.benchmark_id);
    if (
      scenario.count !== audit.expected_incoming ||
      scenario.count !== audit.accepted_incoming ||
      scenario.count !== caller.count ||
      scenario.count !== caller.latency_ms.count ||
      caller.outcomes.length !== 1 ||
      caller.outcomes[0]?.outcome !== "accepted" ||
      caller.outcomes[0].count !== scenario.count
    ) {
      return yield* new EvidenceCardError({ operation: "match receipt workload authority" });
    }

    const receiptSlo =
      input.receiptSlo === undefined
        ? undefined
        : yield* decode(ReceiptSloSchema, input.receiptSlo, "decode receipt SLO derivation");
    if (
      receiptSlo !== undefined &&
      (receiptSlo.total !== scenario.count ||
        !Number.isInteger(receiptSlo.total) ||
        !Number.isInteger(receiptSlo.over_threshold) ||
        receiptSlo.over_threshold < 0 ||
        receiptSlo.over_threshold > receiptSlo.total ||
        receiptSlo.within_threshold_ratio !==
          (receiptSlo.total - receiptSlo.over_threshold) / receiptSlo.total ||
        receiptSlo.source_manifest_sha256 !== sourceManifestSha256)
    ) {
      return yield* new EvidenceCardError({ operation: "match receipt SLO authority" });
    }
    const withinRatio =
      receiptSlo?.within_threshold_ratio ?? (caller.latency_ms.max <= 1000 ? 1 : 0);
    const reconciliationPass =
      audit.verdict === "PASS" &&
      audit.nonterminal_agent_runs === 0 &&
      audit.duplicate_terminal_commits === 0 &&
      audit.unfinished_agent_run_attempts === 0 &&
      audit.unfinished_model_call_attempts === 0 &&
      audit.authoritative_agent_runs === audit.succeeded_agent_runs &&
      audit.accepted_incoming === audit.good_root_outcomes;
    const receiptPass =
      receiptSlo === undefined
        ? caller.latency_ms.max <= 1000
        : receiptSlo.within_threshold_ratio >= 0.999;
    const status = reconciliationPass && receiptPass ? ("PASS" as const) : ("FAIL" as const);

    return {
      id: input.id,
      title: input.title,
      runId: scenario.benchmark_id,
      status,
      timestamps: {
        startedAt: scenario.started_at,
        offerEndedAt: scenario.offer_ended_at,
        endedAt: scenario.ended_at,
      },
      workload: `${integer.format(scenario.count)} commands at ${integer.format(scenario.rate_per_second)}/s for ${integer.format(scenario.duration_seconds)}s${scenario.principal_count === undefined ? "" : `, ${integer.format(scenario.principal_count)} principals`}`,
      resultLines: [
        `${integer.format(audit.accepted_incoming)} / ${integer.format(audit.expected_incoming)} accepted`,
        `${formatPercent(withinRatio)} within 1s, receipt p99 ${decimal.format(caller.latency_ms.p99)} ms`,
        `${integer.format(audit.good_root_outcomes)} Good Root Outcomes, ${integer.format(audit.succeeded_agent_runs)} / ${integer.format(audit.authoritative_agent_runs)} AgentRuns succeeded`,
        `Accepted-work reconciliation ${reconciliationPass ? "PASS" : "FAIL"}; receipt gate ${receiptPass ? "PASS" : "FAIL"}`,
      ],
      sourceManifestSha256,
      disclaimer: POST_RUN_DISCLAIMER,
    } satisfies EvidenceCardModel;
  });

export const buildDeliveryCardModel = (input: {
  readonly id: string;
  readonly title: string;
  readonly sourceManifestSha256: string;
  readonly scenario: Schema.Json;
  readonly audit: Schema.Json;
}) =>
  Effect.gen(function* () {
    const scenario = yield* decode(
      DeliveryScenarioSchema,
      input.scenario,
      "decode delivery scenario",
    );
    const audit = yield* decode(DeliveryAuditSchema, input.audit, "decode delivery audit");
    const sourceManifestSha256 = yield* decode(
      Sha256Schema,
      input.sourceManifestSha256,
      "decode delivery source manifest checksum",
    );
    yield* matchingBenchmark(scenario.benchmark_id, audit.benchmark_id);
    const completedBeforeOfferEnd =
      Date.parse(audit.last_completed_at) <= Date.parse(audit.offer_ended_at);
    const reconciled =
      audit.expected === scenario.count &&
      audit.total === audit.expected &&
      audit.succeeded === audit.expected &&
      audit.canceled === 0 &&
      audit.nonterminal === 0 &&
      audit.duplicate_terminals === 0 &&
      completedBeforeOfferEnd;

    return {
      id: input.id,
      title: input.title,
      runId: scenario.benchmark_id,
      status: reconciled ? ("PASS" as const) : ("FAIL" as const),
      timestamps: {
        startedAt: scenario.started_at,
        offerEndedAt: scenario.offer_ended_at,
        endedAt: scenario.ended_at,
      },
      workload: `${integer.format(scenario.count)} pre-admitted AgentRuns at ${integer.format(scenario.rate_per_second)}/s for ${integer.format(scenario.duration_seconds)}s, ${integer.format(scenario.worker_fixed_instances)} workers`,
      resultLines: [
        `${integer.format(audit.succeeded)} / ${integer.format(audit.expected)} AgentRuns succeeded`,
        `claim p99 ${decimal.format(audit.delivery_to_claim_ms.p99)} ms`,
        completedBeforeOfferEnd
          ? "all work completed before offer end"
          : "work remained after offer end",
        `delivery reconciliation ${reconciled ? "PASS" : "FAIL"}`,
      ],
      sourceManifestSha256,
      disclaimer: POST_RUN_DISCLAIMER,
    } satisfies EvidenceCardModel;
  });

export const buildWorkerLossCardModel = (input: {
  readonly phase: "before-claim" | "after-claim";
  readonly sourceManifestSha256: string;
  readonly scenario: Schema.Json;
  readonly audit: Schema.Json;
}) =>
  Effect.gen(function* () {
    const scenario = yield* decode(
      WorkerLossScenarioSchema,
      input.scenario,
      "decode worker-loss scenario",
    );
    const audit = yield* decode(WorkerLossAuditSchema, input.audit, "decode worker-loss audit");
    const sourceManifestSha256 = yield* decode(
      Sha256Schema,
      input.sourceManifestSha256,
      "decode worker-loss source manifest checksum",
    );
    yield* matchingBenchmark(scenario.benchmark_id, audit.benchmark_id);
    const expectedLane = `worker-process-loss-${input.phase}`;
    if (scenario.lane !== expectedLane) {
      return yield* new EvidenceCardError({ operation: `match ${input.phase} worker-loss lane` });
    }
    const reconciled =
      audit.verdict === "PASS" &&
      audit.expected_incoming === 1 &&
      audit.accepted_incoming === 1 &&
      audit.authoritative_agent_runs === 1 &&
      audit.succeeded_agent_runs === 1 &&
      audit.good_root_outcomes === 1 &&
      audit.nonterminal_agent_runs === 0 &&
      audit.duplicate_terminal_commits === 0 &&
      audit.unfinished_agent_run_attempts === 0 &&
      audit.unfinished_model_call_attempts === 0;
    const injectedExits = audit.delivery_attempt_outcomes.injected_process_exit ?? 0;
    const completedDeliveries = audit.delivery_attempt_outcomes.completed ?? 0;
    const alreadyTerminal = audit.delivery_attempt_outcomes.already_terminal_or_missing ?? 0;
    const phaseLabel = input.phase === "before-claim" ? "before claim" : "after claim";
    const deliveryLine =
      input.phase === "after-claim"
        ? `${integer.format(audit.delivery_attempts)} delivery attempts, ${integer.format(injectedExits)} injected process exit${injectedExits === 1 ? "" : "s"}`
        : `${integer.format(audit.delivery_attempts)} delivery attempts: ${integer.format(completedDeliveries)} completed, ${integer.format(alreadyTerminal)} already terminal or missing`;

    const card: EvidenceCardModel = {
      id: `worker-loss-${input.phase}`,
      title: `Worker process loss ${phaseLabel}`,
      runId: scenario.benchmark_id,
      status: reconciled ? ("PASS" as const) : ("FAIL" as const),
      timestamps: {
        startedAt: scenario.started_at,
        endedAt: scenario.ended_at,
      },
      workload: `1 accepted message, 1 AgentRun, process loss ${phaseLabel}`,
      resultLines: [
        "1 / 1 accepted message produced a Good Root Outcome",
        deliveryLine,
        "zero nonterminal work, duplicate terminals, or unfinished attempts",
        `focused worker-loss reconciliation ${reconciled ? "PASS" : "FAIL"}`,
      ],
      sourceManifestSha256,
      disclaimer: POST_RUN_DISCLAIMER,
    };
    return card;
  });

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

export const renderCardHtml = (card: EvidenceCardModel) => {
  const resultRows = card.resultLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  const statusClass = card.status === "PASS" ? "pass" : "fail";
  const offerEnded =
    card.timestamps.offerEndedAt === undefined
      ? ""
      : `<div><div class="label">Offer ended</div><div class="value">${escapeHtml(card.timestamps.offerEndedAt)}</div></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(card.title)}</title>
<style>
*{box-sizing:border-box}body{margin:0;width:1600px;height:900px;background:#f4f7fb;color:#16233a;font-family:Inter,ui-sans-serif,system-ui,sans-serif;padding:64px}main{height:100%;background:white;border:1px solid #cad5e5;border-radius:24px;padding:42px 48px 34px;box-shadow:0 20px 60px #29415f1a;display:grid;grid-template-rows:auto auto 1fr auto;gap:20px}.eyebrow{font-size:20px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#4d6688}h1{font-size:48px;line-height:1.05;margin:8px 0 0}.status{justify-self:start;border-radius:999px;padding:12px 28px;font-size:26px;font-weight:900;letter-spacing:.08em}.pass{background:#d9f8e8;color:#12643c}.fail{background:#ffe0df;color:#9b2222}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px 56px}.label{font-size:17px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#60738e}.value{font-size:23px;font-weight:650;margin-top:6px;overflow-wrap:anywhere}.span{grid-column:1/-1}ul{margin:8px 0 0;padding-left:24px;font-size:23px;line-height:1.45}.disclaimer{border-top:2px solid #e4eaf2;padding-top:16px;font-size:20px;font-weight:850;color:#334b6d}
</style>
</head>
<body><main>
<header><div class="eyebrow">OpenPoke v1 evidence</div><h1>${escapeHtml(card.title)}</h1></header>
<div class="status ${statusClass}">${card.status}</div>
<section class="grid">
<div><div class="label">Run ID</div><div class="value">${escapeHtml(card.runId)}</div></div>
<div><div class="label">Source manifest SHA-256</div><div class="value">${escapeHtml(card.sourceManifestSha256)}</div></div>
<div><div class="label">Started</div><div class="value">${escapeHtml(card.timestamps.startedAt)}</div></div>
${offerEnded}
<div><div class="label">Run ended</div><div class="value">${escapeHtml(card.timestamps.endedAt)}</div></div>
<div><div class="label">Workload</div><div class="value">${escapeHtml(card.workload)}</div></div>
<div class="span"><div class="label">Exact sealed result</div><ul>${resultRows}</ul></div>
</section>
<footer class="disclaimer">${POST_RUN_DISCLAIMER}</footer>
</main></body>
</html>`;
};
