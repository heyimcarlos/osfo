import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "@effect/vitest";

import { importEvidenceBundles } from "./evidence-importer.js";

const checksum = (contents: string) => createHash("sha256").update(contents).digest("hex");
const execFileAsync = promisify(execFile);

const makeBundle = async (files: Readonly<Record<string, string>>) => {
  const root = await mkdtemp(join(tmpdir(), "osfo-evidence-importer-"));

  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), contents);
  }

  const manifest = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, contents]) => `${checksum(contents)}  ./${name}`)
    .join("\n");
  await writeFile(join(root, "SHA256SUMS"), `${manifest}\n`);

  return root;
};

type TestBundle = Parameters<typeof importEvidenceBundles>[0]["bundles"][number];

const importBundles = (bundles: ReadonlyArray<TestBundle>, selectedRegion = "us-east4") =>
  importEvidenceBundles({ bundles, selectedRegion });

const runCliPaths = (manifest: string, output: string, openMetrics: string, report: string) =>
  execFileAsync("bun", [
    join(process.cwd(), "observability/evidence-importer.ts"),
    "--manifest",
    manifest,
    "--output",
    output,
    "--openmetrics",
    openMetrics,
    "--report",
    report,
  ]);

const runCli = (manifest: string, outputDirectory: string) =>
  runCliPaths(
    manifest,
    join(outputDirectory, "openpoke.prom"),
    join(outputDirectory, "openpoke.openmetrics"),
    join(outputDirectory, "report.json"),
  );

const scenario = JSON.stringify({
  manifest: "issue-87-postgres-admission-stability-r400k-v1",
  benchmark_id: "us-east4-current-wal",
  candidate: "streaming-pull-lockin",
  lane: "matrix-A-clean-current-wal",
  repetition: 1,
  region: "us-east4",
  database_wal_envelope: "current",
  rate_per_second: 232,
  duration_seconds: 1800,
  count: 417_600,
  started_at: "2026-08-06T23:42:59Z",
  ended_at: "2026-08-07T00:14:48Z",
});

const completeCorrectnessFields = {
  accepted_incoming: 10,
  authoritative_agent_runs: 15,
  succeeded_agent_runs: 15,
  good_root_outcomes: 10,
  nonterminal_agent_runs: 0,
  unpublished_outbox_records: 0,
  stranded_accepted_runs: 0,
  ghost_delivery_attempts: 0,
  duplicate_terminal_commits: 0,
  unfinished_agent_run_attempts: 0,
  unfinished_model_call_attempts: 0,
  unknown_caller_outcomes: 0,
  stale_commit_violations: 0,
  ordering_violations: 0,
  inflight_agent_run_budget_mismatch: 0,
  principal_budget_mismatch: 0,
} as const;

const fullPassingFiles = (
  benchmarkId: string,
  scenarioFields: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, string>> => {
  const rootOutcomes = typeof scenarioFields.count === "number" ? scenarioFields.count : 10;
  return {
    "audit.json": JSON.stringify({
      ...completeCorrectnessFields,
      accepted_incoming: rootOutcomes,
      benchmark_id: benchmarkId,
      completed_root_outcomes: rootOutcomes,
      duplicate_publications: 0,
      expected_incoming: rootOutcomes,
      good_root_outcomes: rootOutcomes,
      verdict: "PASS",
    }),
    "first-meaningful-event.json": JSON.stringify({
      verdict: "PASS",
      within_10_seconds_ratio: 0.99,
    }),
    "multi-device.json": JSON.stringify({
      concurrent_sse_connections: 4,
      converged: true,
      device_cursor_positions: 4,
      ordering_violations: 0,
      replay_latency_ms: 2_000,
      requirements: {
        concurrent_sse_connections: "PASS",
        device_cursor_positions: "PASS",
        replay_latency: "PASS",
      },
      stream_duplicates: 0,
      stream_gaps: 0,
      verdict: "PASS",
    }),
    "qualification-metrics.json": JSON.stringify({
      benchmark_id: benchmarkId,
      receipt: { within_1_second_ratio: 1 },
      reconciliation: { verdict: "PASS" },
      region: "us-east4",
    }),
    "recovery.json": JSON.stringify({
      backlog_bounded: true,
      drain_duration_seconds: 1_200,
      full_drain_within_20_minutes: true,
      process_cut_timeline_seconds: 60,
      progress_within_5_minutes: true,
      recovery_rate_per_second: 609,
      requirements: {
        dependency_outage: "PASS",
        process_cut_timeline: "PASS",
        recovery_rate: "PASS",
      },
      verdict: "PASS",
    }),
    "scenario.json": JSON.stringify({
      benchmark_id: benchmarkId,
      count: rootOutcomes,
      region: "us-east4",
      ...scenarioFields,
    }),
  };
};

const audit = JSON.stringify({
  benchmark_id: "us-east4-current-wal",
  expected_incoming: 417_600,
  accepted_incoming: 416_518,
  completed_root_outcomes: 416_518,
  good_root_outcomes: 416_518,
  authoritative_agent_runs: 624_784,
  succeeded_agent_runs: 624_784,
  nonterminal_agent_runs: 0,
  ghost_delivery_attempts: 0,
  duplicate_publications: 0,
  duplicate_terminal_commits: 0,
  unpublished_outbox_records: 0,
  stranded_accepted_runs: 0,
  unfinished_agent_run_attempts: 0,
  unfinished_model_call_attempts: 0,
  unknown_caller_outcomes: 0,
  stale_commit_violations: 0,
  ordering_violations: 0,
  inflight_agent_run_budget_mismatch: 0,
  principal_budget_mismatch: 0,
  caller_to_receipt_ms: { p95: 2617.853, p99: 4557.002, max: 37_851.826 },
  verdict: "PASS",
});

const qualification = JSON.stringify({
  matrix_cell: "matrix-A-clean-current-wal",
  region: "us-east4",
  wal_envelope: "current",
  receipt: { within_1_second_ratio: 0.8369348659003831, p99_ms: 4557.002 },
  atomic_admission: { mean_ms: 37.374 },
  database: {
    wal_bytes: 14_044_898_294,
    cpu: { p95: 0.6997, max: 0.7121 },
    backends: { p95: 111, max: 119 },
  },
  reconciliation: { verdict: "PASS" },
  pass: false,
});

describe("sealed evidence importer", () => {
  it("normalizes a sealed run while marking absent artifacts MISSING", async () => {
    const root = await makeBundle({
      "audit.json": audit,
      "qualification-metrics.json": qualification,
      "scenario.json": scenario,
    });

    const result = await importBundles([
      {
        root,
        run: "us-east4-current-wal",
        classification: "failed",
      },
    ]);

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      run: "us-east4-current-wal",
      region: "us-east4",
      topology: "streaming-pull",
      cell: "A",
      history: "clean",
      wal: "current",
      classification: "failed",
      offered: 417_600,
      accepted: 416_518,
      completedAgentRuns: 624_784,
      reconciliationStatus: "PASS",
      receiptStatus: "FAIL",
      firstMeaningfulEventStatus: "MISSING",
      overallStatus: "FAIL",
    });
    expect(result.metrics).toContain(
      'openpoke_artifact_status{artifact="checkpoints",run="us-east4-current-wal",status="MISSING"} -1',
    );
    expect(result.metrics).toContain('openpoke_matrix_cell_status{cell="B",status="MISSING"} -1');
    expect(result.metrics).toContain(
      'openpoke_integrity_violations{kind="duplicate_terminal_commits",run="us-east4-current-wal"} 0',
    );
    expect(result.metrics).toContain(
      'openpoke_requirement_status{requirement="concurrent_sse_connections",run="us-east4-current-wal",view="multi_device"} -1',
    );
    expect(result.runs[0]?.completed).toBe(416_518);
    expect(result.runs[0]?.correct).toBe(416_518);
    expect(result.openMetrics).toContain(
      'openpoke_run_status{run="us-east4-current-wal",status="FAIL"} 0 1786061688',
    );
    expect(result.openMetrics).toMatch(/# EOF\n$/u);
    expect(result.metrics).not.toContain("must-not-be-a-label");
  });

  it("rejects checksum-invalid bundles without mutating their source", async () => {
    const root = await makeBundle({ "audit.json": audit, "scenario.json": scenario });
    const scenarioPath = join(root, "scenario.json");
    const before = await stat(scenarioPath);
    await writeFile(scenarioPath, `${scenario}\n`);

    await expect(
      importBundles([{ root, run: "tampered", classification: "failed" }]),
    ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });

    expect(await readFile(scenarioPath, "utf8")).toBe(`${scenario}\n`);
    expect((await stat(scenarioPath)).mode).toBe(before.mode);
  });

  it("rejects malformed recognized JSON after checksum verification", async () => {
    const root = await makeBundle({ "scenario.json": "{" });

    await expect(
      importBundles([{ root, run: "malformed", classification: "pilot" }]),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });
  });

  it("rejects a recognized artifact that is absent from the checksum manifest", async () => {
    const root = await makeBundle({ "audit.json": JSON.stringify({ accepted_incoming: 7 }) });
    await writeFile(
      join(root, "scenario.json"),
      JSON.stringify({ count: 999, region: "attacker-controlled" }),
    );

    await expect(
      importBundles([{ root, run: "unlisted-artifact", classification: "historical" }]),
    ).rejects.toMatchObject({ code: "CHECKSUM_MANIFEST_INVALID" });
  });

  it("rejects a checksum-listed symlink that escapes the evidence root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "osfo-evidence-outside-"));
    const outsideScenario = join(outside, "scenario.json");
    await writeFile(outsideScenario, scenario);
    const root = await mkdtemp(join(tmpdir(), "osfo-evidence-importer-"));
    await symlink(outsideScenario, join(root, "scenario.json"));
    await writeFile(join(root, "SHA256SUMS"), `${checksum(scenario)}  ./scenario.json\n`);

    await expect(
      importBundles([{ root, run: "symlink-escape", classification: "historical" }]),
    ).rejects.toMatchObject({ code: "CHECKSUM_MANIFEST_INVALID" });
  });

  it("rejects malformed request-count monitoring instead of reporting zero", async () => {
    const root = await makeBundle({
      "monitoring/ingress__request_count.json": JSON.stringify({ unit: "1" }),
      "scenario.json": scenario,
    });

    await expect(
      importBundles([{ root, run: "us-east4-current-wal", classification: "failed" }]),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });
  });

  it("requires complete request-count series and keeps empty points MISSING", async () => {
    for (const [run, series] of [
      [
        "missing-response-code",
        { metric: { labels: {} }, points: [{ value: { int64Value: "1" } }] },
      ],
      [
        "malformed-non-429",
        {
          metric: { labels: { response_code: "200" } },
          points: [{ value: { int64Value: "NaN" } }],
        },
      ],
    ] as const) {
      const root = await makeBundle({
        "monitoring/ingress__request_count.json": JSON.stringify({ timeSeries: [series] }),
        "scenario.json": JSON.stringify({ benchmark_id: run }),
      });
      await expect(
        importBundles([{ root, run, classification: "historical" }]),
      ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });
    }

    const emptyRoot = await makeBundle({
      "monitoring/ingress__request_count.json": JSON.stringify({
        timeSeries: [{ metric: { labels: { response_code: "200" } }, points: [] }],
      }),
      "scenario.json": JSON.stringify({ benchmark_id: "empty-request-points" }),
    });
    const result = await importBundles([
      { root: emptyRoot, run: "empty-request-points", classification: "historical" },
    ]);
    expect(result.runs[0]?.cloudRun429s).toBeUndefined();
    expect(result.runs[0]?.artifactStatuses.monitoring).toBe("MISSING");
  });

  it("rejects request-count totals that exceed the safe integer range", async () => {
    const root = await makeBundle({
      "monitoring/ingress__request_count.json": JSON.stringify({
        timeSeries: [
          {
            metric: { labels: { response_code: "429" } },
            points: [
              { value: { int64Value: String(Number.MAX_SAFE_INTEGER) } },
              { value: { int64Value: "1" } },
            ],
          },
        ],
      }),
      "scenario.json": JSON.stringify({ benchmark_id: "request-overflow" }),
    });

    await expect(
      importBundles([{ root, run: "request-overflow", classification: "historical" }]),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });
  });

  it("rejects duplicate run slugs before importing bundles", async () => {
    const root = await makeBundle({ "scenario.json": scenario });

    await expect(
      importBundles([
        { root, run: "duplicate-run", classification: "historical" },
        { root, run: "duplicate-run", classification: "historical" },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects invalid or reversed artifact timestamps", async () => {
    const root = await makeBundle({
      "scenario.json": JSON.stringify({
        started_at: "not-a-timestamp",
        ended_at: "2026-08-06T23:42:59Z",
      }),
    });

    await expect(
      importBundles([{ root, run: "invalid-time", classification: "historical" }]),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });

    const invalidCalendar = await makeBundle({
      "scenario.json": JSON.stringify({
        benchmark_id: "invalid-calendar",
        started_at: "2026-02-30T12:00:00Z",
      }),
    });
    await expect(
      importBundles([
        { root: invalidCalendar, run: "invalid-calendar", classification: "historical" },
      ]),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });

    const conflictingSealedLane = await makeBundle({
      "audit.json": JSON.stringify({ lane: "different-lane-1" }),
      "scenario.json": JSON.stringify({
        benchmark_id: "sealed-lane-conflict",
        lane: "target-232",
        repetition: 1,
      }),
    });
    await expect(
      importBundles([
        {
          root: conflictingSealedLane,
          run: "sealed-lane-conflict",
          classification: "historical",
        },
      ]),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });
  });

  it("sorts the UTC range by validated epoch rather than timestamp text", async () => {
    const later = await makeBundle({
      "scenario.json": JSON.stringify({
        benchmark_id: "later-fraction",
        ended_at: "2026-08-07T00:00:01Z",
        started_at: "2026-08-07T00:00:00.9Z",
      }),
    });
    const earlier = await makeBundle({
      "scenario.json": JSON.stringify({
        benchmark_id: "earlier-fraction",
        ended_at: "2026-08-07T00:00:02Z",
        started_at: "2026-08-07T00:00:00.10Z",
      }),
    });

    const result = await importBundles([
      { root: later, run: "later-fraction", classification: "historical" },
      { root: earlier, run: "earlier-fraction", classification: "historical" },
    ]);
    expect(result.utcRange).toEqual({
      from: "2026-08-07T00:00:00.10Z",
      to: "2026-08-07T00:00:02Z",
    });
  });

  it("imports sealed first-event, recovery, and multi-device gates", async () => {
    const root = await makeBundle({
      "audit.json": JSON.stringify({
        benchmark_id: "complete-evidence",
        ...completeCorrectnessFields,
        completed_root_outcomes: 10,
        duplicate_publications: 0,
        expected_incoming: 10,
        verdict: "PASS",
      }),
      "first-meaningful-event.json": JSON.stringify({
        verdict: "PASS",
        within_10_seconds_ratio: 0.999,
      }),
      "multi-device.json": JSON.stringify({
        concurrent_sse_connections: 4,
        converged: true,
        device_cursor_positions: 4,
        ordering_violations: 0,
        replay_latency_ms: 2_000,
        requirements: {
          concurrent_sse_connections: "PASS",
          device_cursor_positions: "PASS",
          replay_latency: "PASS",
        },
        stream_duplicates: 0,
        stream_gaps: 0,
        verdict: "PASS",
      }),
      "qualification-metrics.json": JSON.stringify({
        receipt: { within_1_second_ratio: 1 },
        reconciliation: { verdict: "PASS" },
      }),
      "recovery.json": JSON.stringify({
        backlog_bounded: true,
        drain_duration_seconds: 1_200,
        full_drain_within_20_minutes: true,
        process_cut_timeline_seconds: 60,
        progress_within_5_minutes: true,
        recovery_rate_per_second: 609,
        requirements: {
          dependency_outage: "PASS",
          process_cut_timeline: "PASS",
          recovery_rate: "PASS",
        },
        verdict: "PASS",
      }),
      "scenario.json": JSON.stringify({
        benchmark_id: "complete-evidence",
        count: 10,
        lane: "matrix-A-clean-current-wal",
        manifest: "issue-87-postgres-admission-stability-r400k-v1",
        region: "us-east4",
      }),
    });

    const result = await importBundles([
      { root, run: "complete-evidence", classification: "historical" },
    ]);

    expect(result.runs[0]).toMatchObject({
      completed: 10,
      correct: 10,
      firstMeaningfulEventStatus: "PASS",
      recoveryStatus: "PASS",
      multiDeviceStatus: "PASS",
      overallStatus: "PASS",
    });
    expect(result.metrics).toContain(
      'qualification_scope="selected-region-candidate",run="complete-evidence",summary="known-gates-passed"',
    );
    expect(result.metrics).not.toContain('run="complete-evidence",summary="qualified"');
    expect(result.metrics).toContain(
      'openpoke_gate_status{gate="production_qualification",run="complete-evidence",status="MISSING"} -1',
    );
    expect(result.metrics).toContain(
      'openpoke_requirement_status{requirement="three_target_repetitions",run="complete-evidence",view="qualification"} -1',
    );
    for (const metric of [
      "openpoke_recovery_rate_per_second",
      "openpoke_process_cut_timeline_seconds",
      "openpoke_recovery_drain_duration_seconds",
      "openpoke_concurrent_sse_connections",
      "openpoke_device_cursor_positions",
      "openpoke_replay_latency_ms",
    ]) {
      expect(result.metrics).toContain(`${metric}{run="complete-evidence"}`);
    }
  });

  it("uses the 99 percent First Meaningful ThreadEvent threshold", async () => {
    const passingRoot = await makeBundle({
      "first-meaningful-event.json": JSON.stringify({
        verdict: "PASS",
        within_10_seconds_ratio: 0.99,
      }),
      "scenario.json": JSON.stringify({ benchmark_id: "first-event-pass" }),
    });
    const failingRoot = await makeBundle({
      "first-meaningful-event.json": JSON.stringify({
        verdict: "PASS",
        within_10_seconds_ratio: 0.989,
      }),
      "scenario.json": JSON.stringify({ benchmark_id: "first-event-fail" }),
    });

    const result = await importBundles([
      { root: passingRoot, run: "first-event-pass", classification: "historical" },
      { root: failingRoot, run: "first-event-fail", classification: "historical" },
    ]);
    expect(result.runs[0]?.firstMeaningfulEventStatus).toBe("PASS");
    expect(result.runs[1]?.firstMeaningfulEventStatus).toBe("FAIL");
  });

  it("builds matrix cells from selected-region qualifying admission evidence only", async () => {
    const montrealRoot = await makeBundle({
      "audit.json": JSON.stringify({ accepted_incoming: 9, expected_incoming: 10 }),
      "scenario.json": JSON.stringify({
        benchmark_id: "montreal-history",
        lane: "matrix-A-clean-current-wal",
        region: "northamerica-northeast1",
      }),
    });
    const selectedRoot = await makeBundle({
      "audit.json": JSON.stringify({
        accepted_incoming: 417_600,
        expected_incoming: 417_600,
      }),
      "scenario.json": JSON.stringify({
        benchmark_id: "selected-region",
        count: 417_600,
        duration_seconds: 1_800,
        lane: "matrix-A-clean-current-wal",
        manifest: "issue-87-postgres-admission-stability-r400k-v1",
        rate_per_second: 232,
        region: "us-east4",
        worker_concurrency: 32,
        worker_db_pool: 8,
        worker_flow_max_outstanding_bytes: 67_108_864,
        worker_flow_max_outstanding_messages: 32,
        worker_pull_streams: 4,
        worker_slots: 32,
      }),
    });
    const wrongWorkloadRoot = await makeBundle({
      "audit.json": JSON.stringify({ accepted_incoming: 41_400, expected_incoming: 41_400 }),
      "scenario.json": JSON.stringify({
        benchmark_id: "wrong-matrix-workload",
        count: 41_400,
        duration_seconds: 1_800,
        lane: "matrix-C-clean-current-wal",
        manifest: "issue-87-postgres-admission-stability-r400k-v1",
        rate_per_second: 23,
        region: "us-east4",
        worker_concurrency: 32,
        worker_db_pool: 8,
        worker_pull_streams: 4,
        worker_slots: 32,
      }),
    });
    const contextualRoot = await makeBundle({
      "scenario.json": JSON.stringify({
        benchmark_id: "same-region-context",
        lane: "matrix-B-accumulated-current-wal",
        region: "us-east4",
      }),
    });

    const result = await importBundles([
      {
        root: montrealRoot,
        run: "montreal-history",
        classification: "retained",
      },
      {
        root: selectedRoot,
        run: "selected-region",
        classification: "historical",
      },
      {
        root: contextualRoot,
        run: "same-region-context",
        classification: "historical",
      },
      {
        root: wrongWorkloadRoot,
        run: "wrong-matrix-workload",
        classification: "historical",
      },
    ]);

    expect(result.runs[0]?.qualifying).toBe(false);
    expect(result.runs[1]?.qualifying).toBe(true);
    expect(result.runs[2]?.qualifying).toBe(false);
    expect(result.metrics).toContain('openpoke_matrix_cell_status{cell="A",status="PASS"} 1');
    expect(result.metrics).toContain('openpoke_matrix_cell_status{cell="B",status="MISSING"} -1');
    expect(result.metrics).toContain('openpoke_matrix_cell_status{cell="C",status="FAIL"} 0');
  });

  it("derives qualification repetition completeness from sealed suite lanes", async () => {
    const suite = "issue-87-production-qualification-v1";
    const targetContract = {
      count: 417_600,
      duration_seconds: 1_800,
      rate_per_second: 232,
      worker_concurrency: 32,
      worker_db_pool: 8,
      worker_flow_max_outstanding_bytes: 67_108_864,
      worker_flow_max_outstanding_messages: 32,
      worker_pull_streams: 4,
      worker_slots: 32,
    } as const;
    const repetitionOne = await makeBundle(
      fullPassingFiles("target-repetition-1", {
        ...targetContract,
        lane: "target-232",
        manifest: suite,
        repetition: 1,
      }),
    );
    const repetitionThree = await makeBundle(
      fullPassingFiles("target-repetition-3", {
        ...targetContract,
        lane: "target-232",
        manifest: suite,
        repetition: 3,
      }),
    );
    const incomplete = await importBundles([
      {
        root: repetitionOne,
        run: "target-repetition-1",
        classification: "historical",
      },
      {
        root: repetitionThree,
        run: "target-repetition-3",
        classification: "historical",
      },
    ]);
    expect(incomplete.metrics).toContain(
      'openpoke_requirement_status{requirement="three_target_repetitions",run="target-repetition-1",view="qualification"} -1',
    );
    expect(incomplete.metrics).toContain(
      'qualification_scope="selected-region-candidate",run="target-repetition-1",summary="known-gates-passed"',
    );
    expect(incomplete.metrics).not.toContain('summary="qualified"');

    const failedFiles = fullPassingFiles("target-repetition-2", {
      ...targetContract,
      lane: "target-232",
      manifest: suite,
      repetition: 2,
    });
    const failedRepetition = await makeBundle({
      ...failedFiles,
      "audit.json": JSON.stringify({
        ...completeCorrectnessFields,
        accepted_incoming: 417_599,
        authoritative_agent_runs: 14,
        completed_root_outcomes: 417_599,
        expected_incoming: 417_600,
        good_root_outcomes: 417_599,
        succeeded_agent_runs: 14,
      }),
      "qualification-metrics.json": JSON.stringify({
        benchmark_id: "target-repetition-2",
        receipt: { within_1_second_ratio: 1 },
        region: "us-east4",
      }),
    });
    const failed = await importBundles([
      {
        root: repetitionOne,
        run: "target-repetition-1",
        classification: "historical",
      },
      {
        root: failedRepetition,
        run: "target-repetition-2",
        classification: "failed",
      },
      {
        root: repetitionThree,
        run: "target-repetition-3",
        classification: "historical",
      },
    ]);
    expect(failed.metrics).toContain(
      'openpoke_requirement_status{requirement="three_target_repetitions",run="target-repetition-1",view="qualification"} 0',
    );
    expect(failed.metrics).not.toContain('summary="qualified"');
  });

  it("requires the exact target workload and explicit flow-control limits", async () => {
    const suite = "issue-87-workload-contract-v1";
    const exactTarget = {
      count: 417_600,
      duration_seconds: 1_800,
      lane: "target-232",
      manifest: suite,
      rate_per_second: 232,
      worker_concurrency: 32,
      worker_db_pool: 8,
      worker_flow_max_outstanding_bytes: 67_108_864,
      worker_flow_max_outstanding_messages: 32,
      worker_pull_streams: 4,
      worker_slots: 32,
    } as const;
    const bundlesFor = async (
      prefix: string,
      fieldsFor: (repetition: number) => Readonly<Record<string, unknown>>,
    ) =>
      Promise.all(
        [1, 2, 3].map(async (repetition) => {
          const run = `${prefix}-${repetition}`;
          return {
            classification: "historical" as const,
            root: await makeBundle(
              fullPassingFiles(run, {
                ...exactTarget,
                repetition,
                ...fieldsFor(repetition),
              }),
            ),
            run,
          };
        }),
      );

    const wrongWorkload = await importBundles(
      await bundlesFor("wrong-target", (repetition) =>
        repetition === 2 ? { rate_per_second: 231 } : {},
      ),
    );
    expect(wrongWorkload.metrics).toContain(
      'openpoke_requirement_status{requirement="three_target_repetitions",run="wrong-target-1",view="qualification"} 0',
    );

    const missingFlowControl = await importBundles(
      await bundlesFor("missing-flow", () => ({
        worker_flow_max_outstanding_messages: undefined,
      })),
    );
    expect(missingFlowControl.metrics).toContain(
      'openpoke_requirement_status{requirement="three_target_repetitions",run="missing-flow-1",view="qualification"} -1',
    );

    const exact = await importBundles(await bundlesFor("exact-target", () => ({})));
    expect(exact.metrics).toContain(
      'openpoke_requirement_status{requirement="three_target_repetitions",run="exact-target-1",view="qualification"} 1',
    );
  });

  it("requires exact six-worker and eight-worker recovery reserve fleets", async () => {
    const suite = "issue-87-recovery-reserve-v1";
    const reserveBundle = async (run: string, laneFleet: 6 | 8, actualFleet: number) => ({
      classification: "historical" as const,
      root: await makeBundle(
        fullPassingFiles(run, {
          count: 36_540,
          duration_seconds: 60,
          lane: `recovery-rate-609-workers-${laneFleet}`,
          manifest: suite,
          rate_per_second: 609,
          repetition: 1,
          worker_concurrency: 32,
          worker_db_pool: 8,
          worker_fixed_instances: actualFleet,
          worker_flow_max_outstanding_bytes: 67_108_864,
          worker_flow_max_outstanding_messages: 32,
          worker_pull_streams: 4,
          worker_slots: 32,
        }),
      ),
      run,
    });

    const exact = await importBundles([
      await reserveBundle("reserve-worker-6", 6, 6),
      await reserveBundle("reserve-worker-8", 8, 8),
    ]);
    expect(exact.metrics).toContain(
      'openpoke_requirement_status{requirement="six_worker_recovery_reserve",run="reserve-worker-6",view="qualification"} 1',
    );
    expect(exact.metrics).toContain(
      'openpoke_requirement_status{requirement="eight_worker_recovery_reserve",run="reserve-worker-6",view="qualification"} 1',
    );

    const wrongFleet = await importBundles([await reserveBundle("wrong-reserve-worker-6", 6, 8)]);
    expect(wrongFleet.metrics).toContain(
      'openpoke_requirement_status{requirement="six_worker_recovery_reserve",run="wrong-reserve-worker-6",view="qualification"} 0',
    );
  });

  it("requires exact pre-admitted and combined control workloads", async () => {
    const suite = "issue-87-control-workloads-v1";
    const flowControl = {
      repetition: 1,
      worker_concurrency: 32,
      worker_db_pool: 8,
      worker_fixed_instances: 4,
      worker_flow_max_outstanding_bytes: 67_108_864,
      worker_flow_max_outstanding_messages: 32,
      worker_pull_streams: 4,
      worker_slots: 32,
    } as const;
    const preAdmitted = await makeBundle(
      fullPassingFiles("wrong-pre-admitted", {
        ...flowControl,
        count: 20_820,
        duration_seconds: 60,
        lane: "pre-admitted-348",
        manifest: suite,
        rate_per_second: 347,
      }),
    );
    const combined = await makeBundle(
      fullPassingFiles("wrong-combined-target", {
        ...flowControl,
        count: 13_860,
        duration_seconds: 60,
        lane: "combined-target-232",
        manifest: suite,
        rate_per_second: 231,
      }),
    );

    const result = await importBundles([
      { root: preAdmitted, run: "wrong-pre-admitted", classification: "historical" },
      { root: combined, run: "wrong-combined-target", classification: "historical" },
    ]);
    expect(result.metrics).toContain(
      'openpoke_requirement_status{requirement="pre_admitted_348_control",run="wrong-pre-admitted",view="qualification"} 0',
    );
    expect(result.metrics).toContain(
      'openpoke_requirement_status{requirement="combined_232_target",run="wrong-pre-admitted",view="qualification"} 0',
    );
  });

  it("rejects manifest and sealed identity or region contradictions", async () => {
    const conflictingOverride = await makeBundle({
      "qualification-metrics.json": JSON.stringify({ region: "us-east4" }),
      "scenario.json": JSON.stringify({
        benchmark_id: "sealed-run",
        lane: "matrix-A-clean-current-wal",
        region: "us-east4",
      }),
    });
    await expect(
      importBundles([
        {
          root: conflictingOverride,
          run: "manifest-alias",
          classification: "historical",
          region: "northamerica-northeast1",
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const conflictingSealedRegion = await makeBundle({
      "qualification-metrics.json": JSON.stringify({ region: "us-east4" }),
      "scenario.json": JSON.stringify({
        benchmark_id: "sealed-region-conflict",
        lane: "matrix-A-clean-current-wal",
        region: "northamerica-northeast1",
      }),
    });
    await expect(
      importBundles([
        {
          root: conflictingSealedRegion,
          run: "sealed-region-conflict",
          classification: "historical",
        },
      ]),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });
  });

  it("does not let unsealed manifest metadata establish a qualifying identity or region", async () => {
    const root = await makeBundle({
      "scenario.json": JSON.stringify({ benchmark_id: "sealed-montreal", lane: "target-232" }),
    });

    await expect(
      importBundles([
        {
          root,
          run: "sealed-montreal",
          classification: "retained",
          region: "us-east4",
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("derives correctness from Good Root Outcomes and integrity counters", async () => {
    const scenarioWithIdentity = JSON.stringify({
      benchmark_id: "correctness-evidence",
      lane: "target-232",
      region: "us-east4",
    });
    const missingGoodRootOutcomes = await makeBundle({
      "audit.json": JSON.stringify({
        accepted_incoming: 10,
        duplicate_publications: 0,
        duplicate_terminal_commits: 0,
        ghost_delivery_attempts: 0,
        nonterminal_agent_runs: 0,
        stranded_accepted_runs: 0,
        unfinished_agent_run_attempts: 0,
        unfinished_model_call_attempts: 0,
        verdict: "PASS",
      }),
      "qualification-metrics.json": JSON.stringify({
        receipt: { within_1_second_ratio: 1 },
        region: "us-east4",
      }),
      "scenario.json": scenarioWithIdentity,
    });
    const missing = await importBundles([
      {
        root: missingGoodRootOutcomes,
        run: "correctness-evidence",
        classification: "historical",
      },
    ]);
    expect(missing.runs[0]?.reconciliationStatus).toBe("MISSING");
    expect(missing.runs[0]?.overallStatus).toBe("MISSING");

    const contradictoryPass = await makeBundle({
      "audit.json": JSON.stringify({
        accepted_incoming: 10,
        good_root_outcomes: 10,
        duplicate_publications: 0,
        duplicate_terminal_commits: 0,
        ghost_delivery_attempts: 1,
        nonterminal_agent_runs: 0,
        stranded_accepted_runs: 0,
        unfinished_agent_run_attempts: 0,
        unfinished_model_call_attempts: 0,
        verdict: "PASS",
      }),
      "scenario.json": scenarioWithIdentity,
    });
    await expect(
      importBundles([
        {
          root: contradictoryPass,
          run: "correctness-evidence",
          classification: "historical",
        },
      ]),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });

    const contradictoryVerdicts = await makeBundle({
      "audit.json": JSON.stringify({
        accepted_incoming: 10,
        good_root_outcomes: 10,
        duplicate_publications: 0,
        duplicate_terminal_commits: 0,
        ghost_delivery_attempts: 0,
        nonterminal_agent_runs: 0,
        stranded_accepted_runs: 0,
        unfinished_agent_run_attempts: 0,
        unfinished_model_call_attempts: 0,
        verdict: "FAIL",
      }),
      "qualification-metrics.json": JSON.stringify({
        reconciliation: { verdict: "PASS" },
        region: "us-east4",
      }),
      "scenario.json": scenarioWithIdentity,
    });
    await expect(
      importBundles([
        {
          root: contradictoryVerdicts,
          run: "correctness-evidence",
          classification: "historical",
        },
      ]),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });

    const partialKnownFailure = await makeBundle({
      "audit.json": JSON.stringify({ ghost_delivery_attempts: 1 }),
      "scenario.json": scenarioWithIdentity,
    });
    const partial = await importBundles([
      {
        root: partialKnownFailure,
        run: "correctness-evidence",
        classification: "historical",
      },
    ]);
    expect(partial.runs[0]?.reconciliationStatus).toBe("FAIL");
    expect(partial.runs[0]?.overallStatus).toBe("FAIL");

    const authoritativeFailure = await makeBundle({
      "audit.json": JSON.stringify({ verdict: "FAIL" }),
      "scenario.json": scenarioWithIdentity,
    });
    const failed = await importBundles([
      {
        root: authoritativeFailure,
        run: "correctness-evidence",
        classification: "historical",
      },
    ]);
    expect(failed.runs[0]?.reconciliationStatus).toBe("FAIL");

    const qualificationOverclaimsMissing = await makeBundle({
      "audit.json": JSON.stringify({ accepted_incoming: 10 }),
      "qualification-metrics.json": JSON.stringify({
        reconciliation: { verdict: "PASS" },
        region: "us-east4",
      }),
      "scenario.json": scenarioWithIdentity,
    });
    await expect(
      importBundles([
        {
          root: qualificationOverclaimsMissing,
          run: "correctness-evidence",
          classification: "historical",
        },
      ]),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });

    const qualificationContradictsPass = await makeBundle({
      "audit.json": JSON.stringify({
        ...completeCorrectnessFields,
        duplicate_publications: 0,
      }),
      "qualification-metrics.json": JSON.stringify({
        reconciliation: { verdict: "FAIL" },
        region: "us-east4",
      }),
      "scenario.json": scenarioWithIdentity,
    });
    await expect(
      importBundles([
        {
          root: qualificationContradictsPass,
          run: "correctness-evidence",
          classification: "historical",
        },
      ]),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });
  });

  it("requires the authoritative correctness invariant while allowing harmless redelivery", async () => {
    const passingRoot = await makeBundle({
      "audit.json": JSON.stringify({
        ...completeCorrectnessFields,
        duplicate_publications: 7,
        verdict: "PASS",
      }),
      "scenario.json": JSON.stringify({ benchmark_id: "authoritative-pass" }),
    });
    const passing = await importBundles([
      { root: passingRoot, run: "authoritative-pass", classification: "historical" },
    ]);
    expect(passing.runs[0]?.reconciliationStatus).toBe("PASS");

    for (const [run, fields] of [
      ["agent-run-mismatch", { succeeded_agent_runs: 14 }],
      ["unpublished-obligation", { unpublished_outbox_records: 1 }],
      ["unknown-caller", { unknown_caller_outcomes: 1 }],
      ["stale-commit", { stale_commit_violations: 1 }],
      ["ordering-violation", { ordering_violations: 1 }],
      ["global-budget", { inflight_agent_run_budget_mismatch: 1 }],
      ["principal-budget", { principal_budget_mismatch: 1 }],
    ] as const) {
      const root = await makeBundle({
        "audit.json": JSON.stringify({ ...completeCorrectnessFields, ...fields }),
        "scenario.json": JSON.stringify({ benchmark_id: run }),
      });
      const result = await importBundles([{ root, run, classification: "historical" }]);
      expect(result.runs[0]?.reconciliationStatus).toBe("FAIL");
    }

    const incompleteRoot = await makeBundle({
      "audit.json": JSON.stringify({
        ...completeCorrectnessFields,
        stale_commit_violations: undefined,
      }),
      "scenario.json": JSON.stringify({ benchmark_id: "missing-stale-audit" }),
    });
    const incomplete = await importBundles([
      { root: incompleteRoot, run: "missing-stale-audit", classification: "historical" },
    ]);
    expect(incomplete.runs[0]?.reconciliationStatus).toBe("MISSING");
  });

  it("does not substitute Good Root Outcomes for completed root outcomes", async () => {
    const root = await makeBundle({
      "audit.json": JSON.stringify(completeCorrectnessFields),
      "scenario.json": JSON.stringify({ benchmark_id: "distinct-root-outcomes" }),
    });
    const result = await importBundles([
      { root, run: "distinct-root-outcomes", classification: "historical" },
    ]);
    expect(result.runs[0]?.completed).toBeUndefined();
    expect(result.runs[0]?.correct).toBe(10);
    expect(result.metrics).not.toContain(
      'openpoke_count{measure="completed",run="distinct-root-outcomes"}',
    );
    expect(result.metrics).toContain(
      'openpoke_count{measure="correct",run="distinct-root-outcomes"} 10',
    );
  });

  it("rejects impossible root-outcome count relationships", async () => {
    for (const [run, auditFields] of [
      [
        "correct-exceeds-completed",
        { accepted_incoming: 12, completed_root_outcomes: 10, good_root_outcomes: 11 },
      ],
      [
        "completed-exceeds-accepted",
        { accepted_incoming: 10, completed_root_outcomes: 11, good_root_outcomes: 10 },
      ],
      ["correct-exceeds-accepted", { accepted_incoming: 10, good_root_outcomes: 11 }],
    ] as const) {
      const root = await makeBundle({
        "audit.json": JSON.stringify(auditFields),
        "scenario.json": JSON.stringify({ benchmark_id: run }),
      });

      await expect(
        importBundles([{ root, run, classification: "historical" }]),
      ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });
    }
  });

  it("rejects a declared workload volume that contradicts audited incoming work", async () => {
    const root = await makeBundle({
      "audit.json": JSON.stringify({
        accepted_incoming: 10,
        expected_incoming: 10,
        good_root_outcomes: 10,
      }),
      "scenario.json": JSON.stringify({
        benchmark_id: "contradictory-command-volume",
        count: 417_600,
        duration_seconds: 1_800,
        rate_per_second: 232,
      }),
    });

    await expect(
      importBundles([{ root, run: "contradictory-command-volume", classification: "historical" }]),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });
  });

  it("keeps unevidenced optional-gate details MISSING", async () => {
    const root = await makeBundle({
      "audit.json": JSON.stringify({
        accepted_incoming: 10,
        good_root_outcomes: 10,
        duplicate_publications: 0,
        duplicate_terminal_commits: 0,
        ghost_delivery_attempts: 0,
        nonterminal_agent_runs: 0,
        stranded_accepted_runs: 0,
        unfinished_agent_run_attempts: 0,
        unfinished_model_call_attempts: 0,
        verdict: "PASS",
      }),
      "first-meaningful-event.json": JSON.stringify({ verdict: "PASS" }),
      "multi-device.json": JSON.stringify({
        concurrent_sse_connections: 1,
        converged: true,
        device_cursor_positions: 1,
        ordering_violations: 0,
        replay_latency_ms: 1,
        stream_duplicates: 0,
        stream_gaps: 0,
        verdict: "PASS",
      }),
      "qualification-metrics.json": JSON.stringify({
        receipt: { within_1_second_ratio: 1 },
        region: "us-east4",
      }),
      "recovery.json": JSON.stringify({
        backlog_bounded: true,
        full_drain_within_20_minutes: true,
        process_cut_timeline_seconds: 1,
        progress_within_5_minutes: true,
        recovery_rate_per_second: 1,
        verdict: "PASS",
      }),
      "scenario.json": JSON.stringify({
        benchmark_id: "optional-gates",
        count: 10,
        lane: "target-10",
        region: "us-east4",
      }),
    });

    const result = await importBundles([
      { root, run: "optional-gates", classification: "historical" },
    ]);
    expect(result.runs[0]?.firstMeaningfulEventStatus).toBe("MISSING");
    expect(result.runs[0]?.recoveryStatus).toBe("FAIL");
    expect(result.runs[0]?.multiDeviceStatus).toBe("FAIL");
    expect(result.runs[0]?.overallStatus).toBe("FAIL");
    expect(result.metrics).toContain(
      'openpoke_requirement_status{requirement="recovery_rate",run="optional-gates",view="recovery"} 0',
    );
    for (const requirement of ["process_cut_timeline"]) {
      expect(result.metrics).toContain(
        `openpoke_requirement_status{requirement="${requirement}",run="optional-gates",view="recovery"} -1`,
      );
    }
    for (const requirement of ["concurrent_sse_connections", "device_cursor_positions"]) {
      expect(result.metrics).toContain(
        `openpoke_requirement_status{requirement="${requirement}",run="optional-gates",view="multi_device"} 0`,
      );
    }
    for (const requirement of ["replay_latency"]) {
      expect(result.metrics).toContain(
        `openpoke_requirement_status{requirement="${requirement}",run="optional-gates",view="multi_device"} -1`,
      );
    }
  });

  it("requires recovery and multi-device measurements in addition to PASS verdicts", async () => {
    const verdictOnlyRoot = await makeBundle({
      "multi-device.json": JSON.stringify({
        converged: true,
        ordering_violations: 0,
        requirements: {
          concurrent_sse_connections: "PASS",
          device_cursor_positions: "PASS",
          replay_latency: "PASS",
        },
        stream_duplicates: 0,
        stream_gaps: 0,
        verdict: "PASS",
      }),
      "recovery.json": JSON.stringify({
        backlog_bounded: true,
        full_drain_within_20_minutes: true,
        progress_within_5_minutes: true,
        requirements: {
          dependency_outage: "PASS",
          process_cut_timeline: "PASS",
          recovery_rate: "PASS",
        },
        verdict: "PASS",
      }),
      "scenario.json": JSON.stringify({ benchmark_id: "verdict-only-gates" }),
    });
    const verdictOnly = await importBundles([
      { root: verdictOnlyRoot, run: "verdict-only-gates", classification: "historical" },
    ]);
    expect(verdictOnly.runs[0]?.recoveryStatus).toBe("MISSING");
    expect(verdictOnly.runs[0]?.multiDeviceStatus).toBe("MISSING");

    const belowThresholdRoot = await makeBundle({
      "multi-device.json": JSON.stringify({
        concurrent_sse_connections: 3,
        converged: true,
        device_cursor_positions: 3,
        ordering_violations: 0,
        replay_latency_ms: 2_001,
        requirements: {
          concurrent_sse_connections: "PASS",
          device_cursor_positions: "PASS",
          replay_latency: "PASS",
        },
        stream_duplicates: 0,
        stream_gaps: 0,
        verdict: "PASS",
      }),
      "recovery.json": JSON.stringify({
        backlog_bounded: true,
        drain_duration_seconds: 1_201,
        full_drain_within_20_minutes: true,
        process_cut_timeline_seconds: 60,
        progress_within_5_minutes: true,
        recovery_rate_per_second: 608,
        requirements: {
          dependency_outage: "PASS",
          process_cut_timeline: "PASS",
          recovery_rate: "PASS",
        },
        verdict: "PASS",
      }),
      "scenario.json": JSON.stringify({ benchmark_id: "below-threshold-gates" }),
    });
    const belowThreshold = await importBundles([
      {
        root: belowThresholdRoot,
        run: "below-threshold-gates",
        classification: "historical",
      },
    ]);
    expect(belowThreshold.runs[0]?.recoveryStatus).toBe("FAIL");
    expect(belowThreshold.runs[0]?.multiDeviceStatus).toBe("FAIL");
  });

  it("rejects negative, fractional-count, and out-of-range ratio evidence", async () => {
    const cases = [
      {
        name: "negative-count",
        files: {
          "scenario.json": JSON.stringify({ benchmark_id: "negative-count", count: -1 }),
        },
      },
      {
        name: "fractional-count",
        files: {
          "audit.json": JSON.stringify({ accepted_incoming: 1.5 }),
          "scenario.json": JSON.stringify({ benchmark_id: "fractional-count" }),
        },
      },
      {
        name: "invalid-ratio",
        files: {
          "qualification-metrics.json": JSON.stringify({
            receipt: { within_1_second_ratio: 1.01 },
          }),
          "scenario.json": JSON.stringify({ benchmark_id: "invalid-ratio" }),
        },
      },
    ] as const;

    for (const testCase of cases) {
      const root = await makeBundle(testCase.files);
      await expect(
        importBundles([{ root, run: testCase.name, classification: "historical" }]),
      ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });
    }
  });

  it("emits provenance slugs and hashes without absolute source paths", async () => {
    const root = await makeBundle({
      "scenario.json": JSON.stringify({
        benchmark_id: "safe-provenance",
        lane: "matrix-A-clean-current-wal",
        region: "us-east4",
        worker_delivery: "pull",
      }),
    });

    const result = await importBundles([
      { root, run: "safe-provenance", classification: "historical" },
    ]);

    expect(result.metrics).toContain('run="safe-provenance"');
    expect(result.metrics).toContain("source_hash=");
    expect(result.metrics).not.toContain(root);
    expect(JSON.stringify(result.runs)).not.toContain(root);
    expect(result.metrics).toContain(
      'openpoke_run_narrative_info{bottleneck="not-established",qualification_scope="non-qualifying-context",run="safe-provenance",summary="evidence-incomplete",topology_state="candidate-pending-production-qualification"} 1',
    );
    expect(result.metrics).toContain(
      'openpoke_requirement_status{requirement="three_target_repetitions",run="safe-provenance",view="qualification"} -1',
    );
    expect(result.metrics).toContain(
      'openpoke_requirement_status{requirement="total_cost",run="safe-provenance",view="qualification"} -1',
    );
    expect(result.metrics).toContain(
      'openpoke_topology_decision_info{decision="candidate",reason="pending-production-qualification",topology="streaming-pull"} 1',
    );
    expect(result.metrics).not.toContain('decision="selected"');
  });

  it("rejects malformed manifest metadata at the CLI seam", async () => {
    const root = await makeBundle({ "scenario.json": scenario });
    const output = await mkdtemp(join(tmpdir(), "osfo-evidence-output-"));
    const manifest = join(output, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        selectedRegion: "us-east4",
        bundles: [{ root, run: "bad-classification", classification: "unknown" }],
      }),
    );

    await expect(runCli(manifest, output)).rejects.toMatchObject({ code: 1 });
    await expect(access(join(output, "openpoke.prom"))).rejects.toBeDefined();
  });

  it("refuses every CLI output path that resolves inside an evidence root", async () => {
    const root = await makeBundle({ "scenario.json": scenario });
    const control = await mkdtemp(join(tmpdir(), "osfo-evidence-control-"));
    const manifest = join(control, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        selectedRegion: "us-east4",
        bundles: [{ root, run: "output-escape", classification: "historical" }],
      }),
    );

    await expect(runCli(manifest, root)).rejects.toMatchObject({ code: 1 });
    await expect(access(join(root, "openpoke.prom"))).rejects.toBeDefined();
    await expect(access(join(root, "openpoke.openmetrics"))).rejects.toBeDefined();
    await expect(access(join(root, "report.json"))).rejects.toBeDefined();
  });

  it("rejects existing hard links, dangling symlinks, and manifest collisions", async () => {
    const root = await makeBundle({
      "scenario.json": JSON.stringify({ benchmark_id: "output-aliases" }),
    });
    const control = await mkdtemp(join(tmpdir(), "osfo-evidence-output-alias-"));
    const manifest = join(control, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        bundles: [{ root, run: "output-aliases", classification: "historical" }],
        selectedRegion: "us-east4",
      }),
    );

    const hardLinkOutput = join(control, "hard-link.prom");
    await link(join(root, "scenario.json"), hardLinkOutput);
    await expect(
      runCliPaths(
        manifest,
        hardLinkOutput,
        join(control, "hard-link.openmetrics"),
        join(control, "hard-link-report.json"),
      ),
    ).rejects.toMatchObject({ code: 1 });

    const danglingOutput = join(control, "dangling.prom");
    const escapedTarget = join(root, "created-through-symlink.prom");
    await symlink(escapedTarget, danglingOutput);
    await expect(
      runCliPaths(
        manifest,
        danglingOutput,
        join(control, "dangling.openmetrics"),
        join(control, "dangling-report.json"),
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(access(escapedTarget)).rejects.toBeDefined();

    await expect(
      runCliPaths(
        manifest,
        manifest,
        join(control, "collision.openmetrics"),
        join(control, "collision-report.json"),
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({
      selectedRegion: "us-east4",
    });
  });

  it("publishes fresh CLI outputs without leaving temporary files", async () => {
    const root = await makeBundle({
      "scenario.json": JSON.stringify({ benchmark_id: "atomic-outputs" }),
    });
    const control = await mkdtemp(join(tmpdir(), "osfo-evidence-atomic-output-"));
    const manifest = join(control, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        bundles: [{ root, run: "atomic-outputs", classification: "historical" }],
        selectedRegion: "us-east4",
      }),
    );

    await runCli(manifest, control);
    expect(await readFile(join(control, "openpoke.prom"), "utf8")).toContain(
      'run="atomic-outputs"',
    );
    expect((await readdir(control)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
