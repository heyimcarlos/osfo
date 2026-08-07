import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { importEvidenceBundles } from "./evidence-importer.js";

const checksum = (contents: string) => createHash("sha256").update(contents).digest("hex");

const makeBundle = async (files: Readonly<Record<string, string>>) => {
  const root = await mkdtemp(join(tmpdir(), "osfo-evidence-importer-"));

  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents);
  }

  const manifest = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, contents]) => `${checksum(contents)}  ./${name}`)
    .join("\n");
  await writeFile(join(root, "SHA256SUMS"), `${manifest}\n`);

  return root;
};

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

    const result = await importEvidenceBundles({
      bundles: [{ root, run: "us-east4-current-wal", classification: "failed" }],
    });

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
      completed: 416_518,
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
      'openpoke_requirement_status{requirement="concurrent_sse_connections",view="multi_device"} -1',
    );
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
      importEvidenceBundles({ bundles: [{ root, run: "tampered", classification: "failed" }] }),
    ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });

    expect(await readFile(scenarioPath, "utf8")).toBe(`${scenario}\n`);
    expect((await stat(scenarioPath)).mode).toBe(before.mode);
  });

  it("rejects malformed recognized JSON after checksum verification", async () => {
    const root = await makeBundle({ "scenario.json": "{" });

    await expect(
      importEvidenceBundles({ bundles: [{ root, run: "malformed", classification: "pilot" }] }),
    ).rejects.toMatchObject({ code: "MALFORMED_ARTIFACT" });
  });
});
