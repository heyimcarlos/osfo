import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readlink, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { Exit, Schema } from "effect";

const EvidenceVerdictSchema = Schema.Literals(["PASS", "FAIL"]);
const GateStatusSchema = Schema.Literals(["PASS", "FAIL", "MISSING"]);
const RunClassificationSchema = Schema.Literals(["retained", "failed", "pilot", "historical"]);

export const EvidenceBundleInputSchema = Schema.Struct({
  root: Schema.String,
  run: Schema.String,
  classification: RunClassificationSchema,
  region: Schema.optionalKey(Schema.String),
  topology: Schema.optionalKey(Schema.String),
  cell: Schema.optionalKey(Schema.Literals(["A", "B", "C", "D"])),
  history: Schema.optionalKey(Schema.String),
  wal: Schema.optionalKey(Schema.String),
});

export const EvidenceImportRequestSchema = Schema.Struct({
  bundles: Schema.Array(EvidenceBundleInputSchema),
  selectedRegion: Schema.String,
});

export type GateStatus = typeof GateStatusSchema.Type;
export type RunClassification = typeof RunClassificationSchema.Type;
export type EvidenceBundleInput = typeof EvidenceBundleInputSchema.Type;
export type EvidenceImportRequest = typeof EvidenceImportRequestSchema.Type;

export interface ImportedRun {
  readonly run: string;
  readonly classification: RunClassification;
  readonly qualifying: boolean;
  readonly sourceHash: string;
  readonly region: string;
  readonly topology: string;
  readonly cell: string;
  readonly history: string;
  readonly wal: string;
  readonly evidenceManifest: string | undefined;
  readonly lane: string | undefined;
  readonly repetition: number | undefined;
  readonly workerFixedInstances: number | undefined;
  readonly workerPullStreams: number | undefined;
  readonly workerSlots: number | undefined;
  readonly workerDbPool: number | undefined;
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
  readonly recoveryRatePerSecond: number | undefined;
  readonly processCutTimelineSeconds: number | undefined;
  readonly drainDurationSeconds: number | undefined;
  readonly concurrentSseConnections: number | undefined;
  readonly deviceCursorPositions: number | undefined;
  readonly replayLatencyMs: number | undefined;
  readonly admissionStatus: GateStatus;
  readonly reconciliationStatus: GateStatus;
  readonly receiptStatus: GateStatus;
  readonly firstMeaningfulEventStatus: GateStatus;
  readonly recoveryStatus: GateStatus;
  readonly multiDeviceStatus: GateStatus;
  readonly overallStatus: GateStatus;
  readonly artifactStatuses: Readonly<Record<string, GateStatus>>;
  readonly integrityViolations: Readonly<Record<string, number | undefined>>;
  readonly recoveryRequirementStatuses: Readonly<Record<string, GateStatus>>;
  readonly multiDeviceRequirementStatuses: Readonly<Record<string, GateStatus>>;
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

const recognizedArtifacts = [
  "scenario.json",
  "audit.json",
  "qualification-metrics.json",
  "checkpoints.json",
  "first-meaningful-event.json",
  "recovery.json",
  "multi-device.json",
] as const;

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Ratio = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const OptionalNonNegativeFinite = Schema.optionalKey(NonNegativeFinite);
const OptionalNonNegativeInteger = Schema.optionalKey(NonNegativeInteger);
const OptionalRatio = Schema.optionalKey(Ratio);
const OptionalString = Schema.optionalKey(Schema.String);

const ScenarioArtifactSchema = Schema.Struct({
  benchmark_id: Schema.String,
  candidate: OptionalString,
  count: OptionalNonNegativeInteger,
  database_wal_envelope: OptionalString,
  duration_seconds: OptionalNonNegativeFinite,
  ended_at: OptionalString,
  lane: OptionalString,
  manifest: OptionalString,
  rate_per_second: OptionalNonNegativeFinite,
  region: OptionalString,
  repetition: OptionalNonNegativeInteger,
  started_at: OptionalString,
  worker_delivery: OptionalString,
  worker_db_pool: OptionalNonNegativeInteger,
  worker_fixed_instances: OptionalNonNegativeInteger,
  worker_pull_streams: OptionalNonNegativeInteger,
  worker_slots: OptionalNonNegativeInteger,
});

const AuditArtifactSchema = Schema.Struct({
  benchmark_id: OptionalString,
  lane: OptionalString,
  accepted_incoming: OptionalNonNegativeInteger,
  caller_to_receipt_ms: Schema.optionalKey(
    Schema.Struct({
      max: OptionalNonNegativeFinite,
      p95: OptionalNonNegativeFinite,
      p99: OptionalNonNegativeFinite,
    }),
  ),
  completed_root_outcomes: OptionalNonNegativeInteger,
  duplicate_publications: OptionalNonNegativeInteger,
  duplicate_terminal_commits: OptionalNonNegativeInteger,
  ghost_delivery_attempts: OptionalNonNegativeInteger,
  good_root_outcomes: OptionalNonNegativeInteger,
  authoritative_agent_runs: OptionalNonNegativeInteger,
  inflight_agent_run_budget_mismatch: OptionalNonNegativeInteger,
  nonterminal_agent_runs: OptionalNonNegativeInteger,
  ordering_violations: OptionalNonNegativeInteger,
  outbox_index_bytes: OptionalNonNegativeInteger,
  outbox_table_bytes: OptionalNonNegativeInteger,
  stranded_accepted_runs: OptionalNonNegativeInteger,
  succeeded_agent_runs: OptionalNonNegativeInteger,
  stale_commit_violations: OptionalNonNegativeInteger,
  principal_budget_mismatch: OptionalNonNegativeInteger,
  unknown_caller_outcomes: OptionalNonNegativeInteger,
  unpublished_outbox_records: OptionalNonNegativeInteger,
  unfinished_agent_run_attempts: OptionalNonNegativeInteger,
  unfinished_model_call_attempts: OptionalNonNegativeInteger,
  expected_incoming: OptionalNonNegativeInteger,
  verdict: Schema.optionalKey(EvidenceVerdictSchema),
});

const QualificationArtifactSchema = Schema.Struct({
  benchmark_id: OptionalString,
  matrix_cell: OptionalString,
  atomic_admission: Schema.optionalKey(Schema.Struct({ mean_ms: OptionalNonNegativeFinite })),
  checkpoints: Schema.optionalKey(
    Schema.Struct({
      checkpoint_starts: OptionalNonNegativeInteger,
      duration_seconds: Schema.optionalKey(Schema.Struct({ p95: OptionalNonNegativeFinite })),
    }),
  ),
  database: Schema.optionalKey(
    Schema.Struct({
      backends: Schema.optionalKey(
        Schema.Struct({ max: OptionalNonNegativeFinite, p95: OptionalNonNegativeFinite }),
      ),
      cpu: Schema.optionalKey(Schema.Struct({ max: OptionalRatio, p95: OptionalRatio })),
      wal_bytes: OptionalNonNegativeInteger,
    }),
  ),
  receipt: Schema.optionalKey(
    Schema.Struct({
      max_ms: OptionalNonNegativeFinite,
      p95_ms: OptionalNonNegativeFinite,
      p99_ms: OptionalNonNegativeFinite,
      within_1_second_ratio: OptionalRatio,
    }),
  ),
  reconciliation: Schema.optionalKey(
    Schema.Struct({ verdict: Schema.optionalKey(EvidenceVerdictSchema) }),
  ),
  region: OptionalString,
  wal_envelope: OptionalString,
});

const CheckpointsArtifactSchema = Schema.Struct({ checkpoint_starts: OptionalNonNegativeInteger });

const FirstMeaningfulEventArtifactSchema = Schema.Struct({
  verdict: EvidenceVerdictSchema,
  within_10_seconds_ratio: OptionalRatio,
});

const RecoveryArtifactSchema = Schema.Struct({
  backlog_bounded: Schema.Boolean,
  drain_duration_seconds: OptionalNonNegativeFinite,
  full_drain_within_20_minutes: Schema.Boolean,
  process_cut_timeline_seconds: OptionalNonNegativeFinite,
  progress_within_5_minutes: Schema.Boolean,
  recovery_rate_per_second: OptionalNonNegativeFinite,
  requirements: Schema.optionalKey(
    Schema.Struct({
      dependency_outage: Schema.optionalKey(EvidenceVerdictSchema),
      process_cut_timeline: Schema.optionalKey(EvidenceVerdictSchema),
      recovery_rate: Schema.optionalKey(EvidenceVerdictSchema),
    }),
  ),
  verdict: EvidenceVerdictSchema,
});

const MultiDeviceArtifactSchema = Schema.Struct({
  concurrent_sse_connections: OptionalNonNegativeInteger,
  converged: Schema.Boolean,
  device_cursor_positions: OptionalNonNegativeInteger,
  ordering_violations: NonNegativeInteger,
  replay_latency_ms: OptionalNonNegativeFinite,
  requirements: Schema.optionalKey(
    Schema.Struct({
      concurrent_sse_connections: Schema.optionalKey(EvidenceVerdictSchema),
      device_cursor_positions: Schema.optionalKey(EvidenceVerdictSchema),
      replay_latency: Schema.optionalKey(EvidenceVerdictSchema),
    }),
  ),
  stream_duplicates: NonNegativeInteger,
  stream_gaps: NonNegativeInteger,
  verdict: EvidenceVerdictSchema,
});

const RequestCountArtifactSchema = Schema.Struct({
  timeSeries: Schema.Array(
    Schema.Struct({
      metric: Schema.Struct({
        labels: Schema.Struct({ response_code: Schema.String }),
      }),
      points: Schema.Array(Schema.Struct({ value: Schema.Struct({ int64Value: Schema.String }) })),
    }),
  ),
});

const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const pathEntryExists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

const sha256 = (contents: string | Buffer) => createHash("sha256").update(contents).digest("hex");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeArtifact = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(
  schema: S,
  contents: Buffer | undefined,
  sourceName: string,
): S["Type"] | undefined => {
  if (contents === undefined) return undefined;
  const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(schema))(
    contents.toString("utf8"),
  );
  if (Exit.isFailure(decoded)) {
    throw new EvidenceImportError("MALFORMED_ARTIFACT", sourceName, "invalid artifact schema");
  }
  return decoded.value;
};

interface VerifiedBundle {
  readonly root: string;
  readonly sourceHash: string;
  readonly files: ReadonlyMap<string, Buffer>;
}

const isInside = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);

const readPinnedFile = async (root: string, relativePath: string, errorPath: string) => {
  const absolute = resolve(root, relativePath);
  if (isAbsolute(relativePath) || !isInside(root, absolute)) {
    throw new EvidenceImportError(
      "CHECKSUM_MANIFEST_INVALID",
      errorPath,
      "manifest path escapes bundle root",
    );
  }

  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch {
    throw new EvidenceImportError("CHECKSUM_MISMATCH", relativePath, "listed file is missing");
  }
  if (!isInside(root, canonical)) {
    throw new EvidenceImportError(
      "CHECKSUM_MANIFEST_INVALID",
      errorPath,
      "listed symlink escapes bundle root",
    );
  }

  let handle;
  try {
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorTarget = await readlink(`/proc/self/fd/${handle.fd}`);
    if (!isInside(root, descriptorTarget) || descriptorTarget.endsWith(" (deleted)")) {
      throw new EvidenceImportError(
        "CHECKSUM_MANIFEST_INVALID",
        errorPath,
        "opened file escaped or changed during verification",
      );
    }
    if (!(await handle.stat()).isFile()) {
      throw new EvidenceImportError(
        "CHECKSUM_MANIFEST_INVALID",
        errorPath,
        "listed path is not a regular file",
      );
    }
    return await handle.readFile();
  } catch (cause) {
    if (cause instanceof EvidenceImportError) throw cause;
    throw new EvidenceImportError("CHECKSUM_MISMATCH", relativePath, "listed file is unreadable");
  } finally {
    await handle?.close();
  }
};

const verifyBundle = async (inputRoot: string): Promise<VerifiedBundle> => {
  let root: string;
  try {
    root = await realpath(resolve(inputRoot));
  } catch {
    throw new EvidenceImportError("INVALID_REQUEST", inputRoot, "evidence root does not exist");
  }
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

  const checksumName = checksumPath === sealedPath ? "SEALED-SHA256SUMS" : "SHA256SUMS";
  const manifestBytes = await readPinnedFile(root, checksumName, checksumName);
  const manifest = manifestBytes.toString("utf8");
  const lines = manifest.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new EvidenceImportError("CHECKSUM_MANIFEST_INVALID", checksumPath, "manifest is empty");
  }

  const files = new Map<string, Buffer>();
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

    if (files.has(listed)) {
      throw new EvidenceImportError(
        "CHECKSUM_MANIFEST_INVALID",
        checksumName,
        "manifest lists a file more than once",
      );
    }
    const contents = await readPinnedFile(root, listed, checksumName);

    if (sha256(contents) !== expected) {
      throw new EvidenceImportError("CHECKSUM_MISMATCH", listed, "sha256 does not match manifest");
    }
    files.set(listed, contents);
  }

  for (const artifact of recognizedArtifacts) {
    if (!files.has(artifact) && (await pathEntryExists(resolve(root, artifact)))) {
      throw new EvidenceImportError(
        "CHECKSUM_MANIFEST_INVALID",
        checksumName,
        `${artifact} exists but is not checksum-listed`,
      );
    }
  }

  return { root, sourceHash: sha256(manifestBytes), files };
};

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

const topologyFrom = (scenario: typeof ScenarioArtifactSchema.Type | undefined) => {
  if (scenario?.worker_delivery === "pull") return "streaming-pull";
  const candidate = scenario?.candidate ?? "unspecified";
  return candidate.includes("streaming-pull") ? "streaming-pull" : candidate;
};

const sumCloudRun429s = (files: ReadonlyMap<string, Buffer>) => {
  const requestCountFiles = [...files.keys()].filter(
    (path) => path.startsWith("monitoring/") && path.endsWith("request_count.json"),
  );
  if (requestCountFiles.length === 0) return undefined;

  let total = 0n;
  let observedSeries = false;
  for (const listed of requestCountFiles) {
    const parsed = decodeArtifact(RequestCountArtifactSchema, files.get(listed), listed);
    if (parsed === undefined || parsed.timeSeries.length === 0) continue;
    for (const item of parsed.timeSeries) {
      if (item.points.length > 0) observedSeries = true;
      for (const point of item.points) {
        const raw = point.value.int64Value;
        if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
          throw new EvidenceImportError(
            "MALFORMED_ARTIFACT",
            listed,
            "request-count point is not a non-negative integer",
          );
        }
        const value = BigInt(raw);
        if (item.metric.labels.response_code !== "429") continue;
        total += value;
        if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new EvidenceImportError(
            "MALFORMED_ARTIFACT",
            listed,
            "request-count total exceeds safe integer range",
          );
        }
      }
    }
  }
  return observedSeries ? Number(total) : undefined;
};

const minStatus = (statuses: ReadonlyArray<GateStatus>): GateStatus =>
  statuses.includes("FAIL") ? "FAIL" : statuses.includes("MISSING") ? "MISSING" : "PASS";

const statusValue = (status: GateStatus) => (status === "PASS" ? 1 : status === "FAIL" ? 0 : -1);

const slugPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const validateBoundedSlug = (value: unknown, field: string, sourcePath: string) => {
  if (typeof value !== "string" || !slugPattern.test(value)) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      sourcePath,
      `${field} must be a bounded lowercase slug`,
    );
  }
  return value;
};

const validateTimestamp = (value: string | undefined, field: string) => {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) {
    throw new EvidenceImportError(
      "MALFORMED_ARTIFACT",
      "scenario.json",
      `${field} is not UTC ISO-8601`,
    );
  }
  const milliseconds = Date.parse(value);
  const normalized = value.replace(
    /(?:\.(\d{1,3}))?Z$/u,
    (_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`,
  );
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    throw new EvidenceImportError("MALFORMED_ARTIFACT", "scenario.json", `${field} is invalid`);
  }
  return milliseconds;
};

const importBundle = async (
  input: EvidenceBundleInput,
  selectedRegion: string,
): Promise<ImportedRun> => {
  if (!isRecord(input)) {
    throw new EvidenceImportError("INVALID_REQUEST", "bundles", "each bundle must be an object");
  }
  if (typeof input.root !== "string" || input.root.length === 0) {
    throw new EvidenceImportError("INVALID_REQUEST", "bundles", "root must be a non-empty path");
  }
  if (!slugPattern.test(input.run)) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      input.root,
      "run must be a bounded lowercase slug",
    );
  }
  if (!["retained", "failed", "pilot", "historical"].includes(input.classification)) {
    throw new EvidenceImportError("INVALID_REQUEST", input.run, "classification is invalid");
  }
  for (const [field, value] of [
    ["region", input.region],
    ["topology", input.topology],
    ["history", input.history],
    ["wal", input.wal],
  ] as const) {
    if (value !== undefined) validateBoundedSlug(value, field, input.run);
  }
  if (input.cell !== undefined && !["A", "B", "C", "D"].includes(input.cell)) {
    throw new EvidenceImportError("INVALID_REQUEST", input.run, "cell must be A, B, C, or D");
  }

  const verified = await verifyBundle(input.root);
  const scenarioArtifact = decodeArtifact(
    ScenarioArtifactSchema,
    verified.files.get("scenario.json"),
    "scenario.json",
  );
  const auditArtifact = decodeArtifact(
    AuditArtifactSchema,
    verified.files.get("audit.json"),
    "audit.json",
  );
  const qualificationArtifact = decodeArtifact(
    QualificationArtifactSchema,
    verified.files.get("qualification-metrics.json"),
    "qualification-metrics.json",
  );
  const checkpointsArtifact = decodeArtifact(
    CheckpointsArtifactSchema,
    verified.files.get("checkpoints.json"),
    "checkpoints.json",
  );
  const firstMeaningfulEventArtifact = decodeArtifact(
    FirstMeaningfulEventArtifactSchema,
    verified.files.get("first-meaningful-event.json"),
    "first-meaningful-event.json",
  );
  const recoveryArtifact = decodeArtifact(
    RecoveryArtifactSchema,
    verified.files.get("recovery.json"),
    "recovery.json",
  );
  const multiDeviceArtifact = decodeArtifact(
    MultiDeviceArtifactSchema,
    verified.files.get("multi-device.json"),
    "multi-device.json",
  );

  const sealedRun = validateBoundedSlug(
    scenarioArtifact?.benchmark_id,
    "benchmark_id",
    "scenario.json",
  );
  if (input.run !== sealedRun) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      input.run,
      "run must match the checksum-bound benchmark identity",
    );
  }
  for (const [sourceName, benchmarkId] of [
    ["audit.json", auditArtifact?.benchmark_id],
    ["qualification-metrics.json", qualificationArtifact?.benchmark_id],
  ] as const) {
    if (benchmarkId !== undefined && benchmarkId !== sealedRun) {
      throw new EvidenceImportError(
        "MALFORMED_ARTIFACT",
        sourceName,
        "benchmark identity contradicts scenario.json",
      );
    }
  }

  const sealedRegions = [scenarioArtifact?.region, qualificationArtifact?.region].filter(
    (region): region is string => region !== undefined,
  );
  if (new Set(sealedRegions).size > 1) {
    throw new EvidenceImportError(
      "MALFORMED_ARTIFACT",
      "qualification-metrics.json",
      "sealed region contradicts scenario.json",
    );
  }
  const sealedRegion = sealedRegions[0];
  if (input.region !== undefined && input.region !== sealedRegion) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      input.run,
      "region override must match checksum-bound region evidence",
    );
  }

  const sealedLane = scenarioArtifact?.lane;
  if (sealedLane !== undefined) {
    const repetition = scenarioArtifact?.repetition;
    const repeatedLane = repetition === undefined ? sealedLane : `${sealedLane}-${repetition}`;
    if (
      auditArtifact?.lane !== undefined &&
      auditArtifact.lane !== sealedLane &&
      auditArtifact.lane !== repeatedLane
    ) {
      throw new EvidenceImportError(
        "MALFORMED_ARTIFACT",
        "audit.json",
        "sealed lane contradicts scenario.json",
      );
    }
    if (
      qualificationArtifact?.matrix_cell !== undefined &&
      qualificationArtifact.matrix_cell !== sealedLane
    ) {
      throw new EvidenceImportError(
        "MALFORMED_ARTIFACT",
        "qualification-metrics.json",
        "sealed lane contradicts scenario.json",
      );
    }
  }

  const startedAtMilliseconds = validateTimestamp(scenarioArtifact?.started_at, "started_at");
  const endedAtMilliseconds = validateTimestamp(scenarioArtifact?.ended_at, "ended_at");
  if (
    startedAtMilliseconds !== undefined &&
    endedAtMilliseconds !== undefined &&
    startedAtMilliseconds > endedAtMilliseconds
  ) {
    throw new EvidenceImportError(
      "MALFORMED_ARTIFACT",
      "scenario.json",
      "started_at must not be after ended_at",
    );
  }

  const lane = sealedLane;
  const qualReceipt = qualificationArtifact?.receipt;
  const qualAdmission = qualificationArtifact?.atomic_admission;
  const qualDatabase = qualificationArtifact?.database;
  const qualCpu = qualDatabase?.cpu;
  const qualBackends = qualDatabase?.backends;
  const qualReconciliation = qualificationArtifact?.reconciliation;
  const auditReceipt = auditArtifact?.caller_to_receipt_ms;
  const qualificationCheckpoints = qualificationArtifact?.checkpoints;
  const checkpointDuration = qualificationCheckpoints?.duration_seconds;

  const offered = auditArtifact?.expected_incoming ?? scenarioArtifact?.count;
  const accepted = auditArtifact?.accepted_incoming;
  const completedAgentRuns = auditArtifact?.succeeded_agent_runs;
  const completed = auditArtifact?.completed_root_outcomes;
  const correct = auditArtifact?.good_root_outcomes;
  const receiptWithinOneSecondRatio = qualReceipt?.within_1_second_ratio;
  const receiptStatus: GateStatus =
    receiptWithinOneSecondRatio === undefined
      ? "MISSING"
      : receiptWithinOneSecondRatio >= 0.999
        ? "PASS"
        : "FAIL";
  const authoritativeAgentRuns = auditArtifact?.authoritative_agent_runs;
  const succeededAgentRuns = auditArtifact?.succeeded_agent_runs;
  const integrityCounters = [
    auditArtifact?.duplicate_terminal_commits,
    auditArtifact?.ghost_delivery_attempts,
    auditArtifact?.nonterminal_agent_runs,
    auditArtifact?.unpublished_outbox_records,
    auditArtifact?.stranded_accepted_runs,
    auditArtifact?.unfinished_agent_run_attempts,
    auditArtifact?.unfinished_model_call_attempts,
    auditArtifact?.unknown_caller_outcomes,
    auditArtifact?.stale_commit_violations,
    auditArtifact?.ordering_violations,
    auditArtifact?.inflight_agent_run_budget_mismatch,
    auditArtifact?.principal_budget_mismatch,
  ];
  const knownFieldFailure =
    (accepted !== undefined && correct !== undefined && accepted !== correct) ||
    (authoritativeAgentRuns !== undefined &&
      succeededAgentRuns !== undefined &&
      authoritativeAgentRuns !== succeededAgentRuns) ||
    integrityCounters.some((value) => value !== undefined && value > 0);
  const fieldsComplete =
    accepted !== undefined &&
    correct !== undefined &&
    authoritativeAgentRuns !== undefined &&
    succeededAgentRuns !== undefined &&
    integrityCounters.every((value) => value !== undefined);
  if (
    (knownFieldFailure && auditArtifact?.verdict === "PASS") ||
    (fieldsComplete && !knownFieldFailure && auditArtifact?.verdict === "FAIL")
  ) {
    throw new EvidenceImportError(
      "MALFORMED_ARTIFACT",
      "audit.json",
      "audit verdict contradicts authoritative correctness fields",
    );
  }
  const correctnessStatus: GateStatus =
    knownFieldFailure || auditArtifact?.verdict === "FAIL"
      ? "FAIL"
      : fieldsComplete
        ? "PASS"
        : "MISSING";
  if (
    auditArtifact?.verdict !== undefined &&
    qualReconciliation?.verdict !== undefined &&
    auditArtifact.verdict !== qualReconciliation.verdict
  ) {
    throw new EvidenceImportError(
      "MALFORMED_ARTIFACT",
      "qualification-metrics.json",
      "reconciliation verdict contradicts audit.json",
    );
  }
  if (
    (qualReconciliation?.verdict === "PASS" && correctnessStatus !== "PASS") ||
    (qualReconciliation?.verdict === "FAIL" && correctnessStatus === "PASS")
  ) {
    throw new EvidenceImportError(
      "MALFORMED_ARTIFACT",
      "qualification-metrics.json",
      "reconciliation verdict contradicts authoritative correctness status",
    );
  }
  const reconciliationStatus: GateStatus =
    qualReconciliation?.verdict === "FAIL" ? "FAIL" : correctnessStatus;
  const offeredAcceptedStatus: GateStatus =
    offered === undefined || accepted === undefined
      ? "MISSING"
      : offered === accepted
        ? "PASS"
        : "FAIL";
  const firstMeaningfulEventStatus: GateStatus =
    firstMeaningfulEventArtifact?.within_10_seconds_ratio === undefined
      ? "MISSING"
      : firstMeaningfulEventArtifact.verdict === "PASS" &&
          firstMeaningfulEventArtifact.within_10_seconds_ratio >= 0.99
        ? "PASS"
        : "FAIL";
  const recoveryRequirementStatuses: Readonly<Record<string, GateStatus>> = {
    dependency_outage: recoveryArtifact?.requirements?.dependency_outage ?? "MISSING",
    backlog_accumulation:
      recoveryArtifact === undefined
        ? "MISSING"
        : recoveryArtifact.backlog_bounded
          ? "PASS"
          : "FAIL",
    recovery_rate:
      recoveryArtifact?.requirements?.recovery_rate === "FAIL" ||
      (recoveryArtifact?.recovery_rate_per_second !== undefined &&
        recoveryArtifact.recovery_rate_per_second < 609)
        ? "FAIL"
        : recoveryArtifact?.requirements?.recovery_rate === "PASS" &&
            recoveryArtifact.recovery_rate_per_second !== undefined
          ? "PASS"
          : "MISSING",
    drain_time:
      recoveryArtifact === undefined
        ? "MISSING"
        : !recoveryArtifact.full_drain_within_20_minutes ||
            (recoveryArtifact.drain_duration_seconds !== undefined &&
              recoveryArtifact.drain_duration_seconds > 1_200)
          ? "FAIL"
          : recoveryArtifact.drain_duration_seconds !== undefined
            ? "PASS"
            : "MISSING",
    process_cut_timeline:
      recoveryArtifact?.requirements?.process_cut_timeline === "FAIL"
        ? "FAIL"
        : recoveryArtifact?.requirements?.process_cut_timeline === "PASS" &&
            recoveryArtifact.process_cut_timeline_seconds !== undefined
          ? "PASS"
          : "MISSING",
  };
  const multiDeviceRequirementStatuses: Readonly<Record<string, GateStatus>> = {
    concurrent_sse_connections:
      multiDeviceArtifact?.requirements?.concurrent_sse_connections === "FAIL" ||
      (multiDeviceArtifact?.concurrent_sse_connections !== undefined &&
        multiDeviceArtifact.concurrent_sse_connections < 4)
        ? "FAIL"
        : multiDeviceArtifact?.requirements?.concurrent_sse_connections === "PASS" &&
            multiDeviceArtifact.concurrent_sse_connections !== undefined
          ? "PASS"
          : "MISSING",
    device_cursor_positions:
      multiDeviceArtifact?.requirements?.device_cursor_positions === "FAIL" ||
      (multiDeviceArtifact?.device_cursor_positions !== undefined &&
        multiDeviceArtifact.device_cursor_positions < 4)
        ? "FAIL"
        : multiDeviceArtifact?.requirements?.device_cursor_positions === "PASS" &&
            multiDeviceArtifact.device_cursor_positions !== undefined
          ? "PASS"
          : "MISSING",
    stream_gaps:
      multiDeviceArtifact === undefined
        ? "MISSING"
        : multiDeviceArtifact.stream_gaps === 0
          ? "PASS"
          : "FAIL",
    stream_duplicates:
      multiDeviceArtifact === undefined
        ? "MISSING"
        : multiDeviceArtifact.stream_duplicates === 0
          ? "PASS"
          : "FAIL",
    stream_ordering:
      multiDeviceArtifact === undefined
        ? "MISSING"
        : multiDeviceArtifact.ordering_violations === 0
          ? "PASS"
          : "FAIL",
    replay_latency:
      multiDeviceArtifact?.requirements?.replay_latency === "FAIL" ||
      (multiDeviceArtifact?.replay_latency_ms !== undefined &&
        multiDeviceArtifact.replay_latency_ms > 2_000)
        ? "FAIL"
        : multiDeviceArtifact?.requirements?.replay_latency === "PASS" &&
            multiDeviceArtifact.replay_latency_ms !== undefined
          ? "PASS"
          : "MISSING",
    device_convergence:
      multiDeviceArtifact === undefined
        ? "MISSING"
        : multiDeviceArtifact.converged
          ? "PASS"
          : "FAIL",
  };
  const recoveryStatus: GateStatus =
    recoveryArtifact === undefined
      ? "MISSING"
      : recoveryArtifact.verdict === "FAIL" || !recoveryArtifact.progress_within_5_minutes
        ? "FAIL"
        : minStatus(Object.values(recoveryRequirementStatuses));
  const multiDeviceStatus: GateStatus =
    multiDeviceArtifact === undefined
      ? "MISSING"
      : multiDeviceArtifact.verdict === "FAIL"
        ? "FAIL"
        : minStatus(Object.values(multiDeviceRequirementStatuses));
  const overallStatus = minStatus([
    correctnessStatus,
    offeredAcceptedStatus,
    receiptStatus,
    firstMeaningfulEventStatus,
    recoveryStatus,
    multiDeviceStatus,
  ]);

  const cloudRun429s = sumCloudRun429s(verified.files);
  const artifactStatuses = Object.fromEntries([
    ...recognizedArtifacts.map((name) => [
      name.replace(/\.json$/u, "").replace("qualification-metrics", "qualification"),
      verified.files.has(name) ? "PASS" : "MISSING",
    ]),
    ["monitoring", cloudRun429s === undefined ? "MISSING" : "PASS"],
  ]) as Record<string, GateStatus>;

  const region = sealedRegion ?? "unspecified";
  validateBoundedSlug(region, "region", input.run);
  const sealedTopology = topologyFrom(scenarioArtifact);
  if (input.topology !== undefined && input.topology !== sealedTopology) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      input.run,
      "topology override must match checksum-bound scenario evidence",
    );
  }
  const topology = sealedTopology;
  const sealedCell = cellFrom(lane);
  if (input.cell !== undefined && input.cell !== sealedCell) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      input.run,
      "matrix cell override must match checksum-bound lane evidence",
    );
  }
  const cell = sealedCell;
  const sealedHistory = historyFrom(lane);
  if (input.history !== undefined && input.history !== sealedHistory) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      input.run,
      "history override must match checksum-bound lane evidence",
    );
  }
  const history = sealedHistory;
  const sealedWals = [
    scenarioArtifact?.database_wal_envelope,
    qualificationArtifact?.wal_envelope,
  ].filter((wal): wal is string => wal !== undefined);
  if (new Set(sealedWals).size > 1) {
    throw new EvidenceImportError(
      "MALFORMED_ARTIFACT",
      "qualification-metrics.json",
      "sealed WAL envelope contradicts scenario.json",
    );
  }
  const sealedWal = sealedWals[0];
  if (input.wal !== undefined && input.wal !== sealedWal) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      input.run,
      "WAL override must match checksum-bound evidence",
    );
  }
  const wal = sealedWal ?? "unspecified";
  validateBoundedSlug(topology, "topology", input.run);
  validateBoundedSlug(history, "history", input.run);
  validateBoundedSlug(wal, "wal", input.run);
  if (!["A", "B", "C", "D", "none"].includes(cell)) {
    throw new EvidenceImportError("MALFORMED_ARTIFACT", "scenario.json", "matrix cell is invalid");
  }
  const evidenceManifest = scenarioArtifact?.manifest;
  const isIssue87Suite = evidenceManifest?.startsWith("issue-87-") === true;
  const isQualificationLane =
    cell !== "none" ||
    /^(?:pre-admitted|reference-348|combined-target-232|target-232|worker-process-loss-(?:before|after)-claim|recovery-(?:rate|reserve)-worker(?:6|8))/u.test(
      lane ?? "",
    );
  const qualifying = region === selectedRegion && isIssue87Suite && isQualificationLane;

  return {
    run: sealedRun,
    classification: input.classification,
    qualifying,
    sourceHash: verified.sourceHash,
    region,
    topology,
    cell,
    history,
    wal,
    evidenceManifest,
    lane,
    repetition: scenarioArtifact?.repetition,
    workerFixedInstances: scenarioArtifact?.worker_fixed_instances,
    workerPullStreams: scenarioArtifact?.worker_pull_streams,
    workerSlots: scenarioArtifact?.worker_slots,
    workerDbPool: scenarioArtifact?.worker_db_pool,
    startedAt: scenarioArtifact?.started_at,
    endedAt: scenarioArtifact?.ended_at,
    ratePerSecond: scenarioArtifact?.rate_per_second,
    durationSeconds: scenarioArtifact?.duration_seconds,
    offered,
    accepted,
    completed,
    correct,
    completedAgentRuns,
    receiptWithinOneSecondRatio,
    receiptP95Ms: auditReceipt?.p95 ?? qualReceipt?.p95_ms,
    receiptP99Ms: qualReceipt?.p99_ms ?? auditReceipt?.p99,
    receiptMaxMs: auditReceipt?.max ?? qualReceipt?.max_ms,
    atomicAdmissionMeanMs: qualAdmission?.mean_ms,
    cloudRun429s,
    walBytes: qualDatabase?.wal_bytes,
    databaseCpuP95: qualCpu?.p95,
    databaseCpuMax: qualCpu?.max,
    databaseBackendsP95: qualBackends?.p95,
    databaseBackendsMax: qualBackends?.max,
    outboxTableBytes: auditArtifact?.outbox_table_bytes,
    outboxIndexBytes: auditArtifact?.outbox_index_bytes,
    checkpointStarts:
      checkpointsArtifact?.checkpoint_starts ?? qualificationCheckpoints?.checkpoint_starts,
    checkpointDurationP95Seconds: checkpointDuration?.p95,
    recoveryRatePerSecond: recoveryArtifact?.recovery_rate_per_second,
    processCutTimelineSeconds: recoveryArtifact?.process_cut_timeline_seconds,
    drainDurationSeconds: recoveryArtifact?.drain_duration_seconds,
    concurrentSseConnections: multiDeviceArtifact?.concurrent_sse_connections,
    deviceCursorPositions: multiDeviceArtifact?.device_cursor_positions,
    replayLatencyMs: multiDeviceArtifact?.replay_latency_ms,
    admissionStatus: offeredAcceptedStatus,
    reconciliationStatus,
    receiptStatus,
    firstMeaningfulEventStatus,
    recoveryStatus,
    multiDeviceStatus,
    overallStatus,
    artifactStatuses,
    integrityViolations: {
      duplicate_terminal_commits: auditArtifact?.duplicate_terminal_commits,
      ghost_delivery_attempts: auditArtifact?.ghost_delivery_attempts,
      global_budget_mismatch: auditArtifact?.inflight_agent_run_budget_mismatch,
      nonterminal_agent_runs: auditArtifact?.nonterminal_agent_runs,
      ordering_violations: auditArtifact?.ordering_violations,
      principal_budget_mismatch: auditArtifact?.principal_budget_mismatch,
      stale_commit_violations: auditArtifact?.stale_commit_violations,
      stranded_accepted_runs: auditArtifact?.stranded_accepted_runs,
      unknown_caller_outcomes: auditArtifact?.unknown_caller_outcomes,
      unpublished_outbox_records: auditArtifact?.unpublished_outbox_records,
      unfinished_agent_run_attempts: auditArtifact?.unfinished_agent_run_attempts,
      unfinished_model_call_attempts: auditArtifact?.unfinished_model_call_attempts,
    },
    recoveryRequirementStatuses,
    multiDeviceRequirementStatuses,
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

const qualificationRequirementNames = [
  "pre_admitted_348_control",
  "combined_232_target",
  "three_target_repetitions",
  "before_claim_failure_cut",
  "after_claim_failure_cut",
  "six_worker_recovery_reserve",
  "eight_worker_recovery_reserve",
  "smallest_fixed_fleet_selection",
  "worker_stream_flow_slot_connection_inputs",
  "resource_and_incremental_cost_inputs",
  "internal_claim_latency_distribution",
  "sustained",
  "fairness",
  "retained_corpus",
  "temporal",
  "aggregate_sse",
  "total_cost",
] as const;

const statusesFor = (
  runs: ReadonlyArray<ImportedRun>,
  predicate: (run: ImportedRun) => boolean,
  statusFor: (run: ImportedRun) => GateStatus = (run) => run.overallStatus,
): GateStatus => {
  const statuses = runs.filter(predicate).map(statusFor);
  return statuses.length === 0 ? "MISSING" : minStatus(statuses);
};

const qualificationRequirementsFor = (
  selectedRun: ImportedRun,
  runs: ReadonlyArray<ImportedRun>,
): Readonly<Record<string, GateStatus>> => {
  if (!selectedRun.qualifying) {
    return Object.fromEntries(
      qualificationRequirementNames.map((requirement) => [requirement, "MISSING"] as const),
    );
  }
  const suiteRuns = runs.filter(
    (run) =>
      run.qualifying &&
      run.evidenceManifest === selectedRun.evidenceManifest &&
      run.region === selectedRun.region,
  );
  const laneStatus = (pattern: RegExp, statusFor?: (run: ImportedRun) => GateStatus): GateStatus =>
    statusesFor(suiteRuns, (run) => pattern.test(run.lane ?? ""), statusFor);
  const targetRepetitionStatuses = [1, 2, 3].map((repetition) =>
    statusesFor(suiteRuns, (run) => run.lane === "target-232" && run.repetition === repetition),
  );
  const targetRepetitions = minStatus(targetRepetitionStatuses);
  const workerInputs = suiteRuns.some(
    (run) =>
      (run.workerFixedInstances ?? 0) > 0 &&
      (run.workerPullStreams ?? 0) > 0 &&
      (run.workerSlots ?? 0) > 0 &&
      (run.workerDbPool ?? 0) > 0,
  )
    ? "PASS"
    : "MISSING";
  return {
    pre_admitted_348_control: laneStatus(/^(?:pre-admitted|reference-348)/u),
    combined_232_target: laneStatus(/^combined-target-232/u),
    three_target_repetitions: targetRepetitions,
    before_claim_failure_cut: laneStatus(/^worker-process-loss-before-claim$/u),
    after_claim_failure_cut: laneStatus(/^worker-process-loss-after-claim$/u),
    six_worker_recovery_reserve: laneStatus(
      /^recovery-(?:rate|reserve)-worker6$/u,
      (run) => run.recoveryStatus,
    ),
    eight_worker_recovery_reserve: laneStatus(
      /^recovery-(?:rate|reserve)-worker8$/u,
      (run) => run.recoveryStatus,
    ),
    smallest_fixed_fleet_selection: "MISSING",
    worker_stream_flow_slot_connection_inputs: workerInputs,
    resource_and_incremental_cost_inputs: "MISSING",
    internal_claim_latency_distribution: "MISSING",
    sustained: targetRepetitions,
    fairness: "MISSING",
    retained_corpus: "MISSING",
    temporal: "MISSING",
    aggregate_sse: "MISSING",
    total_cost: "MISSING",
  };
};

const renderMetrics = (runs: ReadonlyArray<ImportedRun>) => {
  const lines = [
    "# OpenPoke presentation metrics are derived views. Checksummed evidence remains authoritative.",
  ];

  for (const run of runs) {
    const base = { run: run.run };
    const qualificationRequirements = qualificationRequirementsFor(run, runs);
    const qualificationStatus = minStatus(Object.values(qualificationRequirements));
    const summary =
      run.overallStatus === "PASS" && run.qualifying && qualificationStatus === "PASS"
        ? "qualified"
        : run.qualifying && qualificationStatus === "FAIL"
          ? "gate-failed"
          : run.overallStatus === "PASS"
            ? "known-gates-passed"
            : run.overallStatus === "MISSING"
              ? "evidence-incomplete"
              : "gate-failed";
    const bottleneck =
      run.admissionStatus === "FAIL" && run.cloudRun429s !== undefined && run.cloudRun429s > 0
        ? "admission-capacity"
        : "not-established";
    lines.push(
      sample("openpoke_run_info", 1, {
        classification: run.classification,
        history: run.history,
        qualifying: String(run.qualifying),
        region: run.region,
        run: run.run,
        source_hash: run.sourceHash,
        topology: run.topology,
        wal: run.wal,
      }),
      sample("openpoke_run_narrative_info", 1, {
        bottleneck,
        qualification_scope: run.qualifying
          ? "selected-region-candidate"
          : "non-qualifying-context",
        run: run.run,
        summary,
        topology_state:
          run.topology === "streaming-pull"
            ? "candidate-pending-production-qualification"
            : "historical-context",
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
      sample(
        "openpoke_gate_status",
        statusValue(
          run.qualifying ? minStatus([run.overallStatus, qualificationStatus]) : "MISSING",
        ),
        {
          ...base,
          gate: "production_qualification",
          status: run.qualifying ? minStatus([run.overallStatus, qualificationStatus]) : "MISSING",
        },
      ),
    );

    const requirementGroups: ReadonlyArray<
      readonly [string, Readonly<Record<string, GateStatus>>]
    > = [
      ["recovery", run.recoveryRequirementStatuses],
      ["multi_device", run.multiDeviceRequirementStatuses],
      ["qualification", qualificationRequirements],
    ];
    for (const [view, requirements] of requirementGroups) {
      for (const [requirement, status] of Object.entries(requirements)) {
        lines.push(
          sample("openpoke_requirement_status", statusValue(status), {
            requirement,
            run: run.run,
            view,
          }),
        );
      }
    }

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
      ["openpoke_recovery_rate_per_second", run.recoveryRatePerSecond],
      ["openpoke_process_cut_timeline_seconds", run.processCutTimelineSeconds],
      ["openpoke_recovery_drain_duration_seconds", run.drainDurationSeconds],
      ["openpoke_concurrent_sse_connections", run.concurrentSseConnections],
      ["openpoke_device_cursor_positions", run.deviceCursorPositions],
      ["openpoke_replay_latency_ms", run.replayLatencyMs],
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
    const statuses = runs
      .filter((run) => run.qualifying && run.cell === cell)
      .map((run) => run.admissionStatus);
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
    ["streaming-pull", "candidate", "pending-production-qualification"],
  ] as const;
  for (const [topology, decision, reason] of topologyDecisions) {
    lines.push(sample("openpoke_topology_decision_info", 1, { decision, reason, topology }));
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
  const starts = runs
    .flatMap((run) => (run.startedAt === undefined ? [] : [run.startedAt]))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const ends = runs
    .flatMap((run) => (run.endedAt === undefined ? [] : [run.endedAt]))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return starts.length === 0 || ends.length === 0
    ? undefined
    : { from: starts[0]!, to: ends[ends.length - 1]! };
};

export const importEvidenceBundles = async (
  request: EvidenceImportRequest,
): Promise<EvidenceImportResult> => {
  const selectedRegion = validateBoundedSlug(request.selectedRegion, "selectedRegion", "manifest");
  if (request.bundles.length === 0) {
    throw new EvidenceImportError("INVALID_REQUEST", "bundles", "at least one bundle is required");
  }
  const seenRuns = new Set<string>();
  for (const bundle of request.bundles) {
    if (isRecord(bundle) && typeof bundle.run === "string") {
      if (seenRuns.has(bundle.run)) {
        throw new EvidenceImportError("INVALID_REQUEST", bundle.run, "run slug is duplicated");
      }
      seenRuns.add(bundle.run);
    }
  }
  const runs = await Promise.all(
    request.bundles.map((bundle) => importBundle(bundle, selectedRegion)),
  );
  const metrics = renderMetrics(runs);
  return {
    runs,
    metrics,
    openMetrics: renderOpenMetrics(metrics, runs),
    utcRange: utcRangeFor(runs),
  };
};

const canonicalOutputTarget = async (inputPath: string) => {
  const target = resolve(inputPath);
  if (await pathEntryExists(target)) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      "outputs",
      "output paths must be fresh and must not be links",
    );
  }
  const parent = await realpath(dirname(target));
  return resolve(parent, basename(target));
};

const assertOutputsOutsideEvidenceRoots = async (
  bundles: ReadonlyArray<EvidenceBundleInput>,
  outputPaths: ReadonlyArray<string>,
  manifestPath: string,
) => {
  const roots = await Promise.all(bundles.map((bundle) => realpath(resolve(bundle.root))));
  const targets = await Promise.all(outputPaths.map(canonicalOutputTarget));
  if (new Set(targets).size !== targets.length) {
    throw new EvidenceImportError("INVALID_REQUEST", "outputs", "output paths must be distinct");
  }
  const canonicalManifest = await realpath(resolve(manifestPath));
  if (targets.includes(canonicalManifest)) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      "outputs",
      "output paths must not collide with the manifest",
    );
  }
  for (const target of targets) {
    if (roots.some((root) => isInside(root, target))) {
      throw new EvidenceImportError(
        "INVALID_REQUEST",
        "outputs",
        "output paths must be outside every evidence root",
      );
    }
  }
  return targets;
};

const readManifestNoFollow = async (manifestPath: string) => {
  let handle;
  try {
    handle = await open(resolve(manifestPath), constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) {
      throw new EvidenceImportError("INVALID_REQUEST", manifestPath, "manifest is not a file");
    }
    return await handle.readFile("utf8");
  } catch (cause) {
    if (cause instanceof EvidenceImportError) throw cause;
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      manifestPath,
      "manifest must be a readable non-symlink file",
    );
  } finally {
    await handle?.close();
  }
};

const publishFreshOutputs = async (
  outputs: ReadonlyArray<readonly [target: string, contents: string]>,
) => {
  const prepared: Array<{ readonly target: string; readonly temporary: string }> = [];
  const published: Array<string> = [];
  try {
    for (const [target, contents] of outputs) {
      const temporary = resolve(dirname(target), `.${basename(target)}.tmp-${randomUUID()}`);
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
        0o644,
      );
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      prepared.push({ target, temporary });
    }

    for (const entry of prepared) {
      if (await pathEntryExists(entry.target)) {
        throw new EvidenceImportError(
          "INVALID_REQUEST",
          "outputs",
          "output path appeared during publication",
        );
      }
      await rename(entry.temporary, entry.target);
      published.push(entry.target);
    }
  } catch (cause) {
    await Promise.allSettled(
      prepared
        .map((entry) => unlink(entry.temporary))
        .concat(published.map((path) => unlink(path))),
    );
    throw cause;
  }
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

  const decodedRequest = Schema.decodeUnknownExit(
    Schema.fromJsonString(EvidenceImportRequestSchema),
  )(await readManifestNoFollow(manifestPath));
  if (Exit.isFailure(decodedRequest)) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      manifestPath,
      "manifest does not match the evidence import schema",
    );
  }
  const request = decodedRequest.value;
  const [outputTarget, openMetricsTarget, reportTarget] = await assertOutputsOutsideEvidenceRoots(
    request.bundles,
    [outputPath, openMetricsPath, reportPath],
    manifestPath,
  );
  const result = await importEvidenceBundles(request);
  await publishFreshOutputs([
    [outputTarget!, result.metrics],
    [openMetricsTarget!, result.openMetrics],
    [
      reportTarget!,
      `${JSON.stringify({ runs: result.runs, utcRange: result.utcRange }, undefined, 2)}\n`,
    ],
  ]);
};

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runCli().catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
