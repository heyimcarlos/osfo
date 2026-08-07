import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  buildMatrixCardModel,
  buildDeliveryCardModel,
  buildReceiptCardModel,
  buildWorkerLossCardModel,
  POST_RUN_DISCLAIMER,
  renderCardHtml,
} from "./demo-evidence-card.js";

const manifestSha = "a".repeat(64);
const execFileAsync = promisify(execFile);

describe("OpenPoke post-run evidence card model", () => {
  it.effect("derives a matrix FAIL from the sealed summary and matching scenario", () =>
    Effect.gen(function* () {
      const card = yield* buildMatrixCardModel({
        cell: "D",
        sourceManifestSha256: manifestSha,
        scenario: {
          benchmark_id: "2238e261-801e-4cb2-888e-1afeb62fc63d",
          lane: "matrix-D-preloaded-larger-wal",
          started_at: "2026-08-07T05:04:01Z",
          offer_ended_at: "2026-08-07T05:34:06Z",
          ended_at: "2026-08-07T05:35:43Z",
          rate_per_second: 232,
          duration_seconds: 1800,
          count: 417600,
          principal_count: 100000,
          inflight_agent_run_capacity: 400000,
        },
        summary: {
          cells: {
            D: {
              matrix_cell: "matrix-D-preloaded-larger-wal",
              workload: {
                rate_per_second: 232,
                duration_seconds: 1800,
                commands: 417600,
                principals: 100000,
              },
              receipt: {
                offered: 417600,
                accepted: 410372,
                unknown: 7228,
                within_1_second_ratio: 0.3512308429118774,
                p99_ms: 13007.533,
              },
              reconciliation: {
                verdict: "PASS",
                good_root_outcomes: 410372,
                authoritative_agent_runs: 615590,
                succeeded_agent_runs: 615590,
              },
              pass: false,
              evidence: { lane_sha256sums_sha256: manifestSha },
            },
          },
        },
      });

      expect(card).toMatchObject({
        id: "matrix-d",
        runId: "2238e261-801e-4cb2-888e-1afeb62fc63d",
        status: "FAIL",
        sourceManifestSha256: manifestSha,
        workload: "417,600 commands at 232/s for 1,800s, 100,000 principals",
      });
      expect(card.resultLines).toEqual([
        "410,372 accepted, 7,228 caller unknown",
        "35.12308429% within 1s, receipt p99 13,007.533 ms",
        "410,372 Good Root Outcomes, 615,590 / 615,590 AgentRuns succeeded",
        "Accepted-work reconciliation PASS; admission FAIL",
      ]);
      expect(card.disclaimer).toBe(POST_RUN_DISCLAIMER);
    }),
  );

  it.effect("derives the sustained receipt-gate FAIL instead of relabeling audit PASS", () =>
    Effect.gen(function* () {
      const card = yield* buildReceiptCardModel({
        id: "sustained-rep2",
        title: "Sustained target, repetition 2",
        sourceManifestSha256: manifestSha,
        scenario: {
          benchmark_id: "f8ad684e-ac05-4d6d-a6ca-8b7de91e5cde",
          lane: "target-232",
          started_at: "2026-08-06T21:28:02Z",
          offer_ended_at: "2026-08-06T21:58:06Z",
          ended_at: "2026-08-06T21:59:47Z",
          rate_per_second: 232,
          duration_seconds: 1800,
          count: 417600,
          principal_count: 100000,
        },
        audit: {
          benchmark_id: "f8ad684e-ac05-4d6d-a6ca-8b7de91e5cde",
          expected_incoming: 417600,
          accepted_incoming: 417600,
          authoritative_agent_runs: 626400,
          succeeded_agent_runs: 626400,
          good_root_outcomes: 417600,
          nonterminal_agent_runs: 0,
          duplicate_terminal_commits: 0,
          unfinished_agent_run_attempts: 0,
          unfinished_model_call_attempts: 0,
          verdict: "PASS",
        },
        callerSummary: {
          count: 417600,
          outcomes: [{ outcome: "accepted", count: 417600 }],
          latency_ms: { count: 417600, p99: 1598.577, max: 10842.108 },
        },
        receiptSlo: {
          run: "sustained-rep2",
          total: 417600,
          over_threshold: 9105,
          within_threshold_ratio: 0.9781968390804597,
          source_manifest_sha256: manifestSha,
        },
      });

      expect(card.status).toBe("FAIL");
      expect(card.resultLines).toContain("97.81968391% within 1s, receipt p99 1,598.577 ms");
      expect(card.resultLines).toContain("Accepted-work reconciliation PASS; receipt gate FAIL");
    }),
  );

  it.effect("fails the receipt gate when more than 0.1% are late even if p99 is within 1s", () =>
    Effect.gen(function* () {
      const card = yield* buildReceiptCardModel({
        id: "ratio-failure",
        title: "Receipt ratio failure",
        sourceManifestSha256: manifestSha,
        scenario: {
          benchmark_id: "f8ad684e-ac05-4d6d-a6ca-8b7de91e5cde",
          lane: "target-232",
          started_at: "2026-08-06T21:28:02Z",
          offer_ended_at: "2026-08-06T21:58:06Z",
          ended_at: "2026-08-06T21:59:47Z",
          rate_per_second: 232,
          duration_seconds: 1800,
          count: 1000,
          principal_count: 100000,
        },
        audit: {
          benchmark_id: "f8ad684e-ac05-4d6d-a6ca-8b7de91e5cde",
          expected_incoming: 1000,
          accepted_incoming: 1000,
          authoritative_agent_runs: 1500,
          succeeded_agent_runs: 1500,
          good_root_outcomes: 1000,
          nonterminal_agent_runs: 0,
          duplicate_terminal_commits: 0,
          unfinished_agent_run_attempts: 0,
          unfinished_model_call_attempts: 0,
          verdict: "PASS",
        },
        callerSummary: {
          count: 1000,
          outcomes: [{ outcome: "accepted", count: 1000 }],
          latency_ms: { count: 1000, p99: 900, max: 2000 },
        },
        receiptSlo: {
          run: "ratio-failure",
          total: 1000,
          over_threshold: 5,
          within_threshold_ratio: 0.995,
          source_manifest_sha256: manifestSha,
        },
      });

      expect(card.status).toBe("FAIL");
      expect(card.resultLines).toContain("Accepted-work reconciliation PASS; receipt gate FAIL");
    }),
  );

  it.effect("fails closed when a sealed scenario lacks required timestamps", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        buildReceiptCardModel({
          id: "short-target",
          title: "Short target",
          sourceManifestSha256: manifestSha,
          scenario: {
            benchmark_id: "da62917d-8fbf-4cce-8e1c-90f87092f23e",
            lane: "combined-target-232-stripes64",
            rate_per_second: 232,
            duration_seconds: 60,
            count: 13920,
            principal_count: 100000,
          },
          audit: {},
          callerSummary: {},
          receiptSlo: undefined,
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect(
    "derives a delivery PASS only when the sealed workload reconciles before offer end",
    () =>
      Effect.gen(function* () {
        const card = yield* buildDeliveryCardModel({
          id: "recovery-4",
          title: "Recovery-rate screen, four workers",
          sourceManifestSha256: manifestSha,
          scenario: {
            benchmark_id: "73e96c29-1acb-4b47-816b-9ac861aa4058",
            lane: "recovery-rate-609-workers-4",
            started_at: "2026-08-06T20:48:33Z",
            offer_ended_at: "2026-08-06T20:49:34Z",
            ended_at: "2026-08-06T20:49:39Z",
            rate_per_second: 609,
            duration_seconds: 60,
            count: 36540,
            worker_fixed_instances: 4,
          },
          audit: {
            benchmark_id: "73e96c29-1acb-4b47-816b-9ac861aa4058",
            expected: 36540,
            total: 36540,
            succeeded: 36540,
            canceled: 0,
            nonterminal: 0,
            duplicate_terminals: 0,
            delivery_to_claim_ms: { p99: 10966.36682 },
            offer_ended_at: "2026-08-06T16:49:34.442263-04:00",
            last_completed_at: "2026-08-06T16:49:34.266771-04:00",
          },
        });

        expect(card.status).toBe("PASS");
        expect(card.workload).toBe("36,540 pre-admitted AgentRuns at 609/s for 60s, 4 workers");
        expect(card.resultLines).toContain("claim p99 10,966.367 ms");
        expect(card.resultLines).toContain("all work completed before offer end");
      }),
  );

  it.effect("derives focused worker-loss scope without inventing an offer timestamp", () =>
    Effect.gen(function* () {
      const card = yield* buildWorkerLossCardModel({
        phase: "after-claim",
        sourceManifestSha256: manifestSha,
        scenario: {
          benchmark_id: "89141a7d-f1fa-4345-8ef5-d544f23132ac",
          lane: "worker-process-loss-after-claim",
          started_at: "2026-08-06T20:46:27Z",
          ended_at: "2026-08-06T20:46:39Z",
        },
        audit: {
          benchmark_id: "89141a7d-f1fa-4345-8ef5-d544f23132ac",
          expected_incoming: 1,
          accepted_incoming: 1,
          authoritative_agent_runs: 1,
          succeeded_agent_runs: 1,
          good_root_outcomes: 1,
          nonterminal_agent_runs: 0,
          duplicate_terminal_commits: 0,
          unfinished_agent_run_attempts: 0,
          unfinished_model_call_attempts: 0,
          delivery_attempts: 2,
          delivery_attempt_outcomes: { completed: 1, injected_process_exit: 1 },
          verdict: "PASS",
        },
      });

      expect(card.status).toBe("PASS");
      expect(card.timestamps.offerEndedAt).toBeUndefined();
      expect(card.workload).toBe("1 accepted message, 1 AgentRun, process loss after claim");
      expect(card.resultLines).toContain("2 delivery attempts, 1 injected process exit");
    }),
  );

  it.effect("renders the required disclaimer and no executable card content", () =>
    Effect.gen(function* () {
      const card = yield* buildReceiptCardModel({
        id: "short-target",
        title: "Short target <sealed>",
        sourceManifestSha256: manifestSha,
        scenario: {
          benchmark_id: "da62917d-8fbf-4cce-8e1c-90f87092f23e",
          lane: "combined-target-232-stripes64",
          started_at: "2026-08-06T20:35:26Z",
          offer_ended_at: "2026-08-06T20:36:26Z",
          ended_at: "2026-08-06T20:37:32Z",
          rate_per_second: 232,
          duration_seconds: 60,
          count: 13920,
          principal_count: 100000,
        },
        audit: {
          benchmark_id: "da62917d-8fbf-4cce-8e1c-90f87092f23e",
          expected_incoming: 13920,
          accepted_incoming: 13920,
          authoritative_agent_runs: 20880,
          succeeded_agent_runs: 20880,
          good_root_outcomes: 13920,
          nonterminal_agent_runs: 0,
          duplicate_terminal_commits: 0,
          unfinished_agent_run_attempts: 0,
          unfinished_model_call_attempts: 0,
          verdict: "PASS",
        },
        callerSummary: {
          count: 13920,
          outcomes: [{ outcome: "accepted", count: 13920 }],
          latency_ms: { count: 13920, p99: 631.585, max: 797.256 },
        },
        receiptSlo: undefined,
      });

      const html = renderCardHtml(card);
      expect(html).toContain(POST_RUN_DISCLAIMER);
      expect(html).toContain("Short target &lt;sealed&gt;");
      expect(html).not.toContain("<script");
    }),
  );

  it("runs packet verification before creating renderer output", async () => {
    const root = await mkdtemp(join(tmpdir(), "osfo-card-preflight-"));
    try {
      const indexPath = join(root, "artifact-index.json");
      await writeFile(indexPath, "not valid JSON");

      await expect(
        execFileAsync("bun", [
          join(process.cwd(), "observability/render-demo-evidence-cards.ts"),
          indexPath,
        ]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("packet verification preflight failed"),
      });
      await expect(access(join(root, "assets/post-run"))).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
