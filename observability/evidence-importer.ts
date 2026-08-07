import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type GateStatus = "PASS" | "FAIL" | "MISSING";
export type RunClassification = "retained" | "failed" | "pilot" | "historical";

export interface EvidenceBundleInput {
  readonly root: string;
  readonly run: string;
  readonly classification: RunClassification;
  readonly qualifying?: boolean;
  readonly region?: string;
  readonly topology?: string;
  readonly cell?: string;
  readonly history?: string;
  readonly wal?: string;
}

export interface EvidenceImportRequest {
  readonly bundles: ReadonlyArray<EvidenceBundleInput>;
}

export interface ImportedRun {
  readonly run: string;
  readonly classification: RunClassification;
  readonly qualifying: boolean;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly region: string;
  readonly topology: string;
  readonly cell: string;
  readonly history: string;
  readonly wal: string;
  readonly startedAt: string | undefined;
  readonly endedAt: string | undefined;
  readonly ratePerSecond: number | undefined;
  readonly durationSeconds: number | undefined;
  readonly offered: number | undefined;
  readonly accepted: number | undefined;
  readonly completed: number | undefined;
  readonly correct: number | undefined;
  readonly completedAgentRuns: number | undefined;
  readonly receiptWithinOneSecondRatio: number | undefined;
  readonly receiptP95Ms: number | undefined;
  readonly receiptP99Ms: number | undefined;
  readonly receiptMaxMs: number | undefined;
  readonly atomicAdmissionMeanMs: number | undefined;
  readonly cloudRun429s: number | undefined;
  readonly walBytes: number | undefined;
  readonly databaseCpuP95: number | undefined;
  readonly databaseCpuMax: number | undefined;
  readonly databaseBackendsP95: number | undefined;
  readonly databaseBackendsMax: number | undefined;
  readonly outboxTableBytes: number | undefined;
  readonly outboxIndexBytes: number | undefined;
  readonly checkpointStarts: number | undefined;
  readonly checkpointDurationP95Seconds: number | undefined;
  readonly admissionStatus: GateStatus;
  readonly reconciliationStatus: GateStatus;
  readonly receiptStatus: GateStatus;
  readonly firstMeaningfulEventStatus: GateStatus;
  readonly recoveryStatus: GateStatus;
  readonly multiDeviceStatus: GateStatus;
  readonly overallStatus: GateStatus;
  readonly artifactStatuses: Readonly<Record<string, GateStatus>>;
  readonly integrityViolations: Readonly<Record<string, number | undefined>>;
}

export interface EvidenceImportResult {
  readonly runs: ReadonlyArray<ImportedRun>;
  readonly metrics: string;
  readonly openMetrics: string;
  readonly utcRange: { readonly from: string; readonly to: string } | undefined;
}

type EvidenceImportErrorCode =
  | "CHECKSUM_MANIFEST_MISSING"
  | "CHECKSUM_MANIFEST_INVALID"
  | "CHECKSUM_MISMATCH"
  | "MALFORMED_ARTIFACT"
  | "INVALID_REQUEST";

export class EvidenceImportError extends Error {
  readonly code: EvidenceImportErrorCode;
  readonly sourcePath: string;

  constructor(code: EvidenceImportErrorCode, sourcePath: string, detail: string) {
    super(`${code}: ${sourcePath}: ${detail}`);
    this.name = "EvidenceImportError";
    this.code = code;
    this.sourcePath = sourcePath;
  }
}

type JsonObject = Record<string, unknown>;

const recognizedArtifacts = [
  "scenario.json",
  "audit.json",
  "qualification-metrics.json",
  "checkpoints.json",
] as const;

const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const sha256 = (contents: string | Buffer) => createHash("sha256").update(contents).digest("hex");

const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const stringAt = (value: unknown, key: string) => {
  const field = asObject(value)?.[key];
  return typeof field === "string" ? field : undefined;
};

const numberAt = (value: unknown, key: string) => {
  const field = asObject(value)?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
};

const objectAt = (value: unknown, key: string) => asObject(asObject(value)?.[key]);

const parseArtifact = async (path: string) => {
  if (!(await exists(path))) return undefined;

  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const object = asObject(parsed);
    if (object === undefined) {
      throw new EvidenceImportError("MALFORMED_ARTIFACT", path, "expected a JSON object");
    }
    return object;
  } catch (cause) {
    if (cause instanceof EvidenceImportError) throw cause;
    throw new EvidenceImportError("MALFORMED_ARTIFACT", path, "invalid JSON");
  }
};

interface VerifiedBundle {
  readonly root: string;
  readonly sourceHash: string;
  readonly listedFiles: ReadonlySet<string>;
}

const verifyBundle = async (inputRoot: string): Promise<VerifiedBundle> => {
  const root = resolve(inputRoot);
  const sealedPath = resolve(root, "SEALED-SHA256SUMS");
  const ordinaryPath = resolve(root, "SHA256SUMS");
  const checksumPath = (await exists(sealedPath))
    ? sealedPath
    : (await exists(ordinaryPath))
      ? ordinaryPath
      : undefined;

  if (checksumPath === undefined) {
    throw new EvidenceImportError(
      "CHECKSUM_MANIFEST_MISSING",
      root,
      "expected SEALED-SHA256SUMS or SHA256SUMS",
    );
  }

  const manifest = await readFile(checksumPath, "utf8");
  const lines = manifest.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new EvidenceImportError("CHECKSUM_MANIFEST_INVALID", checksumPath, "manifest is empty");
  }

  const listedFiles = new Set<string>();
  for (const line of lines) {
    const match = /^([a-fA-F0-9]{64})\s+[ *]?(\.\/.+)$/u.exec(line);
    if (match === null) {
      throw new EvidenceImportError(
        "CHECKSUM_MANIFEST_INVALID",
        checksumPath,
        "invalid sha256sum line",
      );
    }

    const expected = match[1]?.toLowerCase();
    const listed = match[2]?.slice(2);
    if (expected === undefined || listed === undefined || listed.includes("\0")) {
      throw new EvidenceImportError(
        "CHECKSUM_MANIFEST_INVALID",
        checksumPath,
        "invalid sha256sum capture",
      );
    }
    const absolute = resolve(root, listed);
    if (isAbsolute(listed) || (absolute !== root && !absolute.startsWith(`${root}${sep}`))) {
      throw new EvidenceImportError(
        "CHECKSUM_MANIFEST_INVALID",
        checksumPath,
        "manifest path escapes bundle root",
      );
    }

    let contents: Buffer;
    try {
      contents = await readFile(absolute);
    } catch {
      throw new EvidenceImportError("CHECKSUM_MISMATCH", absolute, "listed file is missing");
    }

    if (sha256(contents) !== expected) {
      throw new EvidenceImportError(
        "CHECKSUM_MISMATCH",
        absolute,
        "sha256 does not match manifest",
      );
    }
    listedFiles.add(listed);
  }

  return { root, sourceHash: sha256(manifest), listedFiles };
};

const statusFrom = (value: unknown): GateStatus =>
  value === "PASS" ? "PASS" : value === "FAIL" ? "FAIL" : "MISSING";

const cellFrom = (lane: string | undefined) => {
  const match = /matrix-([A-D])(?:-|$)/u.exec(lane ?? "");
  return match?.[1] ?? "none";
};

const historyFrom = (lane: string | undefined) => {
  if (lane?.includes("clean") === true) return "clean";
  if (lane?.includes("preload") === true || lane?.includes("accumulated") === true) {
    return "accumulated";
  }
  return "unspecified";
};

const topologyFrom = (scenario: JsonObject | undefined) => {
  if (stringAt(scenario, "worker_delivery") === "pull") return "streaming-pull";
  const candidate = stringAt(scenario, "candidate") ?? "unspecified";
  return candidate.includes("streaming-pull") ? "streaming-pull" : candidate;
};

const sumCloudRun429s = async (root: string, listedFiles: ReadonlySet<string>) => {
  const requestCountFiles = [...listedFiles].filter(
    (path) => path.startsWith("monitoring/") && path.endsWith("request_count.json"),
  );
  if (requestCountFiles.length === 0) return undefined;

  let total = 0;
  for (const listed of requestCountFiles) {
    const parsed: unknown = JSON.parse(await readFile(resolve(root, listed), "utf8"));
    const series = asObject(parsed)?.timeSeries;
    if (!Array.isArray(series)) continue;
    for (const item of series) {
      const labels = objectAt(objectAt(item, "metric"), "labels");
      if (stringAt(labels, "response_code") !== "429") continue;
      const points = asObject(item)?.points;
      if (!Array.isArray(points)) continue;
      for (const point of points) {
        const raw = stringAt(objectAt(point, "value"), "int64Value");
        if (raw !== undefined) total += Number(raw);
      }
    }
  }
  return total;
};

const minStatus = (statuses: ReadonlyArray<GateStatus>): GateStatus =>
  statuses.includes("FAIL") ? "FAIL" : statuses.includes("MISSING") ? "MISSING" : "PASS";

const statusValue = (status: GateStatus) => (status === "PASS" ? 1 : status === "FAIL" ? 0 : -1);

const importBundle = async (input: EvidenceBundleInput): Promise<ImportedRun> => {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(input.run)) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      input.root,
      "run must be a bounded lowercase slug",
    );
  }

  const verified = await verifyBundle(input.root);
  const [scenario, audit, qualification, checkpoints] = await Promise.all(
    recognizedArtifacts.map((name) => parseArtifact(resolve(verified.root, name))),
  );
  const [scenarioArtifact, auditArtifact, qualificationArtifact, checkpointsArtifact] = [
    scenario,
    audit,
    qualification,
    checkpoints,
  ];

  const lane = stringAt(scenarioArtifact, "lane");
  const qualReceipt = objectAt(qualificationArtifact, "receipt");
  const qualAdmission = objectAt(qualificationArtifact, "atomic_admission");
  const qualDatabase = objectAt(qualificationArtifact, "database");
  const qualCpu = objectAt(qualDatabase, "cpu");
  const qualBackends = objectAt(qualDatabase, "backends");
  const qualReconciliation = objectAt(qualificationArtifact, "reconciliation");
  const auditReceipt = objectAt(auditArtifact, "caller_to_receipt_ms");
  const checkpointDuration = objectAt(
    objectAt(qualificationArtifact, "checkpoints"),
    "duration_seconds",
  );

  const offered =
    numberAt(auditArtifact, "expected_incoming") ?? numberAt(scenarioArtifact, "count");
  const accepted = numberAt(auditArtifact, "accepted_incoming");
  const completedAgentRuns = numberAt(auditArtifact, "succeeded_agent_runs");
  const goodRootOutcomes = numberAt(auditArtifact, "good_root_outcomes");
  const acceptedRunsAreComplete =
    accepted !== undefined &&
    numberAt(auditArtifact, "nonterminal_agent_runs") === 0 &&
    numberAt(auditArtifact, "duplicate_terminal_commits") === 0;
  const completed = goodRootOutcomes ?? (acceptedRunsAreComplete ? accepted : undefined);
  const correct = goodRootOutcomes ?? (acceptedRunsAreComplete ? accepted : undefined);
  const receiptWithinOneSecondRatio = numberAt(qualReceipt, "within_1_second_ratio");
  const receiptStatus: GateStatus =
    receiptWithinOneSecondRatio === undefined
      ? "MISSING"
      : receiptWithinOneSecondRatio >= 0.999
        ? "PASS"
        : "FAIL";
  const reconciliationStatus = statusFrom(
    stringAt(qualReconciliation, "verdict") ?? stringAt(auditArtifact, "verdict"),
  );
  const offeredAcceptedStatus: GateStatus =
    offered === undefined || accepted === undefined
      ? "MISSING"
      : offered === accepted
        ? "PASS"
        : "FAIL";
  const correctnessStatus = reconciliationStatus;
  const firstMeaningfulEventStatus: GateStatus = "MISSING";
  const recoveryStatus: GateStatus = "MISSING";
  const multiDeviceStatus: GateStatus = "MISSING";
  const overallStatus = minStatus([
    correctnessStatus,
    offeredAcceptedStatus,
    receiptStatus,
    firstMeaningfulEventStatus,
    recoveryStatus,
    multiDeviceStatus,
  ]);

  const artifactStatuses = Object.fromEntries([
    ...recognizedArtifacts.map((name, index) => [
      name.replace(/\.json$/u, "").replace("qualification-metrics", "qualification"),
      [scenarioArtifact, auditArtifact, qualificationArtifact, checkpointsArtifact][index] ===
      undefined
        ? "MISSING"
        : "PASS",
    ]),
    [
      "monitoring",
      [...verified.listedFiles].some((path) => path.startsWith("monitoring/")) ? "PASS" : "MISSING",
    ],
  ]) as Record<string, GateStatus>;

  return {
    run: input.run,
    classification: input.classification,
    qualifying: input.qualifying ?? input.classification === "retained",
    sourcePath: verified.root,
    sourceHash: verified.sourceHash,
    region:
      input.region ??
      stringAt(scenarioArtifact, "region") ??
      stringAt(qualificationArtifact, "region") ??
      "unspecified",
    topology: input.topology ?? topologyFrom(scenarioArtifact),
    cell: input.cell ?? cellFrom(lane),
    history: input.history ?? historyFrom(lane),
    wal:
      input.wal ??
      stringAt(scenarioArtifact, "database_wal_envelope") ??
      stringAt(qualificationArtifact, "wal_envelope") ??
      "unspecified",
    startedAt: stringAt(scenarioArtifact, "started_at"),
    endedAt: stringAt(scenarioArtifact, "ended_at"),
    ratePerSecond: numberAt(scenarioArtifact, "rate_per_second"),
    durationSeconds: numberAt(scenarioArtifact, "duration_seconds"),
    offered,
    accepted,
    completed,
    correct,
    completedAgentRuns,
    receiptWithinOneSecondRatio,
    receiptP95Ms: numberAt(auditReceipt, "p95") ?? numberAt(qualReceipt, "p95_ms"),
    receiptP99Ms: numberAt(qualReceipt, "p99_ms") ?? numberAt(auditReceipt, "p99"),
    receiptMaxMs: numberAt(auditReceipt, "max") ?? numberAt(qualReceipt, "max_ms"),
    atomicAdmissionMeanMs: numberAt(qualAdmission, "mean_ms"),
    cloudRun429s: await sumCloudRun429s(verified.root, verified.listedFiles),
    walBytes: numberAt(qualDatabase, "wal_bytes"),
    databaseCpuP95: numberAt(qualCpu, "p95"),
    databaseCpuMax: numberAt(qualCpu, "max"),
    databaseBackendsP95: numberAt(qualBackends, "p95"),
    databaseBackendsMax: numberAt(qualBackends, "max"),
    outboxTableBytes: numberAt(auditArtifact, "outbox_table_bytes"),
    outboxIndexBytes: numberAt(auditArtifact, "outbox_index_bytes"),
    checkpointStarts:
      numberAt(checkpointsArtifact, "checkpoint_starts") ??
      numberAt(objectAt(qualificationArtifact, "checkpoints"), "checkpoint_starts"),
    checkpointDurationP95Seconds: numberAt(checkpointDuration, "p95"),
    admissionStatus: offeredAcceptedStatus,
    reconciliationStatus,
    receiptStatus,
    firstMeaningfulEventStatus,
    recoveryStatus,
    multiDeviceStatus,
    overallStatus,
    artifactStatuses,
    integrityViolations: {
      duplicate_publications: numberAt(auditArtifact, "duplicate_publications"),
      duplicate_terminal_commits: numberAt(auditArtifact, "duplicate_terminal_commits"),
      ghost_delivery_attempts: numberAt(auditArtifact, "ghost_delivery_attempts"),
      nonterminal_agent_runs: numberAt(auditArtifact, "nonterminal_agent_runs"),
      stranded_accepted_runs: numberAt(auditArtifact, "stranded_accepted_runs"),
      unfinished_agent_run_attempts: numberAt(auditArtifact, "unfinished_agent_run_attempts"),
      unfinished_model_call_attempts: numberAt(auditArtifact, "unfinished_model_call_attempts"),
    },
  };
};

const label = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"')}"`;

const labels = (values: Readonly<Record<string, string>>) =>
  `{${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${label(value)}`)
    .join(",")}}`;

const sample = (name: string, value: number, dimensions: Readonly<Record<string, string>> = {}) =>
  `${name}${Object.keys(dimensions).length === 0 ? "" : labels(dimensions)} ${value}`;

const renderMetrics = (runs: ReadonlyArray<ImportedRun>) => {
  const lines = [
    "# OpenPoke presentation metrics are derived views. Checksummed evidence remains authoritative.",
  ];

  for (const run of runs) {
    const base = { run: run.run };
    lines.push(
      sample("openpoke_run_info", 1, {
        classification: run.classification,
        history: run.history,
        qualifying: String(run.qualifying),
        region: run.region,
        run: run.run,
        source_hash: run.sourceHash,
        source_path: run.sourcePath,
        topology: run.topology,
        wal: run.wal,
      }),
      sample("openpoke_run_status", statusValue(run.overallStatus), {
        ...base,
        status: run.overallStatus,
      }),
      sample("openpoke_gate_status", statusValue(run.admissionStatus), {
        ...base,
        gate: "complete_durable_acceptance",
        status: run.admissionStatus,
      }),
      sample("openpoke_gate_status", statusValue(run.reconciliationStatus), {
        ...base,
        gate: "reconciliation",
        status: run.reconciliationStatus,
      }),
      sample("openpoke_gate_status", statusValue(run.receiptStatus), {
        ...base,
        gate: "durable_receipt_under_1s",
        status: run.receiptStatus,
      }),
      sample("openpoke_gate_status", statusValue(run.firstMeaningfulEventStatus), {
        ...base,
        gate: "first_meaningful_event_under_10s",
        status: run.firstMeaningfulEventStatus,
      }),
      sample("openpoke_gate_status", statusValue(run.recoveryStatus), {
        ...base,
        gate: "recovery",
        status: run.recoveryStatus,
      }),
      sample("openpoke_gate_status", statusValue(run.multiDeviceStatus), {
        ...base,
        gate: "multi_device",
        status: run.multiDeviceStatus,
      }),
    );

    const counts = {
      offered: run.offered,
      accepted: run.accepted,
      completed: run.completed,
      correct: run.correct,
      agent_runs_completed: run.completedAgentRuns,
    };
    for (const [measure, value] of Object.entries(counts)) {
      if (value !== undefined) lines.push(sample("openpoke_count", value, { ...base, measure }));
    }

    const scalarMetrics = [
      ["openpoke_rate_per_second", run.ratePerSecond],
      ["openpoke_duration_seconds", run.durationSeconds],
      ["openpoke_receipt_within_1s_ratio", run.receiptWithinOneSecondRatio],
      ["openpoke_atomic_admission_mean_ms", run.atomicAdmissionMeanMs],
      ["openpoke_cloud_run_429_total", run.cloudRun429s],
      ["openpoke_database_wal_bytes", run.walBytes],
      ["openpoke_database_cpu_p95_ratio", run.databaseCpuP95],
      ["openpoke_database_cpu_max_ratio", run.databaseCpuMax],
      ["openpoke_database_backends_p95", run.databaseBackendsP95],
      ["openpoke_database_backends_max", run.databaseBackendsMax],
      ["openpoke_outbox_table_bytes", run.outboxTableBytes],
      ["openpoke_outbox_index_bytes", run.outboxIndexBytes],
      ["openpoke_checkpoint_starts", run.checkpointStarts],
      ["openpoke_checkpoint_duration_p95_seconds", run.checkpointDurationP95Seconds],
    ] as const;
    for (const [name, value] of scalarMetrics) {
      if (value !== undefined) lines.push(sample(name, value, base));
    }

    const latency = [
      ["0.95", run.receiptP95Ms],
      ["0.99", run.receiptP99Ms],
      ["max", run.receiptMaxMs],
    ] as const;
    for (const [quantile, value] of latency) {
      if (value !== undefined) {
        lines.push(
          sample("openpoke_latency_ms", value, {
            ...base,
            operation: "durable_receipt",
            quantile,
          }),
        );
      }
    }

    for (const [artifact, status] of Object.entries(run.artifactStatuses)) {
      lines.push(
        sample("openpoke_artifact_status", statusValue(status), { artifact, ...base, status }),
      );
    }
    for (const [kind, value] of Object.entries(run.integrityViolations)) {
      if (value !== undefined)
        lines.push(sample("openpoke_integrity_violations", value, { kind, ...base }));
    }
  }

  for (const cell of ["A", "B", "C", "D"]) {
    const statuses = runs.filter((run) => run.cell === cell).map((run) => run.overallStatus);
    lines.push(
      sample(
        "openpoke_matrix_cell_status",
        statusValue(statuses.length === 0 ? "MISSING" : minStatus(statuses)),
        {
          cell,
          status: statuses.length === 0 ? "MISSING" : minStatus(statuses),
        },
      ),
    );
  }

  const topologyDecisions = [
    ["direct-postgresql", "rejected", "dual-write-correctness"],
    ["push", "rejected", "cold-start-tail"],
    ["corrected-push", "rejected", "combined-load-tail"],
    ["sharded-push", "rejected", "complexity-without-slo-win"],
    ["durable-activation", "rejected", "second-hop-complexity"],
    ["streaming-pull", "selected", "predictable-warm-capacity"],
  ] as const;
  for (const [topology, decision, reason] of topologyDecisions) {
    lines.push(sample("openpoke_topology_decision_info", 1, { decision, reason, topology }));
  }

  const missingRequirements = {
    recovery: [
      "dependency_outage",
      "backlog_accumulation",
      "recovery_rate",
      "drain_time",
      "process_cut_timeline",
    ],
    multi_device: [
      "concurrent_sse_connections",
      "device_cursor_positions",
      "stream_gaps",
      "stream_duplicates",
      "stream_ordering",
      "replay_latency",
      "device_convergence",
    ],
  } as const;
  for (const [view, requirements] of Object.entries(missingRequirements)) {
    for (const requirement of requirements) {
      lines.push(sample("openpoke_requirement_status", -1, { requirement, view }));
    }
  }

  lines.push("");
  return lines.join("\n");
};

const renderOpenMetrics = (metrics: string, runs: ReadonlyArray<ImportedRun>) => {
  const presentationTimestamp = Math.max(
    ...runs.map((run) =>
      run.endedAt === undefined ? 0 : Math.floor(Date.parse(run.endedAt) / 1000),
    ),
  );
  const lines = metrics
    .trimEnd()
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => (presentationTimestamp === 0 ? line : `${line} ${presentationTimestamp}`));
  lines.push("# EOF", "");
  return lines.join("\n");
};

const utcRangeFor = (runs: ReadonlyArray<ImportedRun>) => {
  const starts = runs.flatMap((run) => (run.startedAt === undefined ? [] : [run.startedAt])).sort();
  const ends = runs.flatMap((run) => (run.endedAt === undefined ? [] : [run.endedAt])).sort();
  return starts.length === 0 || ends.length === 0
    ? undefined
    : { from: starts[0]!, to: ends[ends.length - 1]! };
};

export const importEvidenceBundles = async (
  request: EvidenceImportRequest,
): Promise<EvidenceImportResult> => {
  if (request.bundles.length === 0) {
    throw new EvidenceImportError("INVALID_REQUEST", "bundles", "at least one bundle is required");
  }
  const runs = await Promise.all(request.bundles.map(importBundle));
  const metrics = renderMetrics(runs);
  return {
    runs,
    metrics,
    openMetrics: renderOpenMetrics(metrics, runs),
    utcRange: utcRangeFor(runs),
  };
};

const runCli = async () => {
  const args = process.argv.slice(2);
  const valueFor = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const manifestPath = valueFor("--manifest");
  const outputPath = valueFor("--output");
  const openMetricsPath = valueFor("--openmetrics");
  const reportPath = valueFor("--report");
  if (
    manifestPath === undefined ||
    outputPath === undefined ||
    openMetricsPath === undefined ||
    reportPath === undefined
  ) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      process.cwd(),
      "usage: evidence-importer.ts --manifest RUNS.json --output METRICS.prom --openmetrics METRICS.openmetrics --report REPORT.json",
    );
  }

  const request: unknown = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  const bundles = asObject(request)?.bundles;
  if (!Array.isArray(bundles)) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      manifestPath,
      "manifest must contain bundles[]",
    );
  }
  const result = await importEvidenceBundles({ bundles: bundles as EvidenceBundleInput[] });
  await writeFile(resolve(outputPath), result.metrics);
  await writeFile(resolve(openMetricsPath), result.openMetrics);
  await writeFile(
    resolve(reportPath),
    `${JSON.stringify({ runs: result.runs, utcRange: result.utcRange }, undefined, 2)}\n`,
  );
};

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runCli().catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
