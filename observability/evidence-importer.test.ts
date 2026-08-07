import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
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

const importBundles = (
  bundles: Parameters<typeof importEvidenceBundles>[0]["bundles"],
  selectedRegion = "us-east4",
) => {
  const request = { bundles, selectedRegion };
  return importEvidenceBundles(request);
};

const runCli = (manifest: string, outputDirectory: string) =>
  execFileAsync("bun", [
    join(process.cwd(), "observability/evidence-importer.ts"),
    "--manifest",
    manifest,
    "--output",
    join(outputDirectory, "openpoke.prom"),
    "--openmetrics",
    join(outputDirectory, "openpoke.openmetrics"),
    "--report",
    join(outputDirectory, "report.json"),
  ]);

const scenario = JSON.stringify({
  benchmark_id: "must-not-be-a-label",
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

const audit = JSON.stringify({
  benchmark_id: "must-not-be-a-label",
  expected_incoming: 417_600,
  accepted_incoming: 416_518,
  authoritative_agent_runs: 624_784,
  succeeded_agent_runs: 624_784,
  nonterminal_agent_runs: 0,
  duplicate_terminal_commits: 0,
  unfinished_agent_run_attempts: 0,
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
        qualifying: true,
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
    expect(result.runs[0]?.completed).toBeUndefined();
    expect(result.runs[0]?.correct).toBeUndefined();
    expect(result.metrics).not.toContain('measure="completed"');
    expect(result.metrics).not.toContain('measure="correct"');
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
      importBundles([{ root, run: "malformed-monitoring", classification: "failed" }]),
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
  });

  it("imports sealed first-event, recovery, and multi-device gates", async () => {
    const root = await makeBundle({
      "audit.json": JSON.stringify({
        accepted_incoming: 10,
        expected_incoming: 10,
        good_root_outcomes: 10,
        verdict: "PASS",
      }),
      "first-meaningful-event.json": JSON.stringify({
        verdict: "PASS",
        within_10_seconds_ratio: 0.995,
      }),
      "multi-device.json": JSON.stringify({
        converged: true,
        ordering_violations: 0,
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
        full_drain_within_20_minutes: true,
        progress_within_5_minutes: true,
        verdict: "PASS",
      }),
      "scenario.json": scenario,
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
  });

  it("builds matrix cells from selected-region qualifying admission evidence only", async () => {
    const montrealRoot = await makeBundle({
      "audit.json": JSON.stringify({ accepted_incoming: 9, expected_incoming: 10 }),
      "scenario.json": JSON.stringify({
        lane: "matrix-A-clean-current-wal",
        region: "northamerica-northeast1",
      }),
    });
    const selectedRoot = await makeBundle({
      "audit.json": JSON.stringify({ accepted_incoming: 10, expected_incoming: 10 }),
      "scenario.json": JSON.stringify({ lane: "matrix-A-clean-current-wal", region: "us-east4" }),
    });

    const result = await importBundles([
      {
        root: montrealRoot,
        run: "montreal-history",
        classification: "retained",
        qualifying: true,
      },
      {
        root: selectedRoot,
        run: "selected-region",
        classification: "historical",
        qualifying: true,
      },
    ]);

    expect(result.runs[0]?.qualifying).toBe(false);
    expect(result.runs[1]?.qualifying).toBe(true);
    expect(result.metrics).toContain('openpoke_matrix_cell_status{cell="A",status="PASS"} 1');
  });

  it("emits provenance slugs and hashes without absolute source paths", async () => {
    const root = await makeBundle({ "scenario.json": scenario });

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
});
