import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readFile, readlink, realpath, writeFile } from "node:fs/promises";
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
  qualifying: Schema.optionalKey(Schema.Boolean),
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

const recognizedArtifacts = [
  "scenario.json",
  "audit.json",
  "qualification-metrics.json",
  "checkpoints.json",
  "first-meaningful-event.json",
  "recovery.json",
  "multi-device.json",
] as const;

const OptionalNumber = Schema.optionalKey(Schema.Number);
const OptionalString = Schema.optionalKey(Schema.String);

const ScenarioArtifactSchema = Schema.Struct({
  candidate: OptionalString,
  count: OptionalNumber,
  database_wal_envelope: OptionalString,
  duration_seconds: OptionalNumber,
  ended_at: OptionalString,
  lane: OptionalString,
  rate_per_second: OptionalNumber,
  region: OptionalString,
  started_at: OptionalString,
  worker_delivery: OptionalString,
});

const AuditArtifactSchema = Schema.Struct({
  accepted_incoming: OptionalNumber,
  caller_to_receipt_ms: Schema.optionalKey(
    Schema.Struct({ max: OptionalNumber, p95: OptionalNumber, p99: OptionalNumber }),
  ),
  completed_root_outcomes: OptionalNumber,
  duplicate_publications: OptionalNumber,
  duplicate_terminal_commits: OptionalNumber,
  ghost_delivery_attempts: OptionalNumber,
  good_root_outcomes: OptionalNumber,
  nonterminal_agent_runs: OptionalNumber,
  outbox_index_bytes: OptionalNumber,
  outbox_table_bytes: OptionalNumber,
  stranded_accepted_runs: OptionalNumber,
  succeeded_agent_runs: OptionalNumber,
  unfinished_agent_run_attempts: OptionalNumber,
  unfinished_model_call_attempts: OptionalNumber,
  expected_incoming: OptionalNumber,
  verdict: Schema.optionalKey(EvidenceVerdictSchema),
});

const QualificationArtifactSchema = Schema.Struct({
  atomic_admission: Schema.optionalKey(Schema.Struct({ mean_ms: OptionalNumber })),
  checkpoints: Schema.optionalKey(
    Schema.Struct({
      checkpoint_starts: OptionalNumber,
      duration_seconds: Schema.optionalKey(Schema.Struct({ p95: OptionalNumber })),
    }),
  ),
  database: Schema.optionalKey(
    Schema.Struct({
      backends: Schema.optionalKey(Schema.Struct({ max: OptionalNumber, p95: OptionalNumber })),
      cpu: Schema.optionalKey(Schema.Struct({ max: OptionalNumber, p95: OptionalNumber })),
      wal_bytes: OptionalNumber,
    }),
  ),
  receipt: Schema.optionalKey(
    Schema.Struct({
      max_ms: OptionalNumber,
      p95_ms: OptionalNumber,
      p99_ms: OptionalNumber,
      within_1_second_ratio: OptionalNumber,
    }),
  ),
  reconciliation: Schema.optionalKey(
    Schema.Struct({ verdict: Schema.optionalKey(EvidenceVerdictSchema) }),
  ),
  region: OptionalString,
  wal_envelope: OptionalString,
});

const CheckpointsArtifactSchema = Schema.Struct({ checkpoint_starts: OptionalNumber });

const FirstMeaningfulEventArtifactSchema = Schema.Struct({
  verdict: EvidenceVerdictSchema,
  within_10_seconds_ratio: OptionalNumber,
});

const RecoveryArtifactSchema = Schema.Struct({
  backlog_bounded: Schema.Boolean,
  full_drain_within_20_minutes: Schema.Boolean,
  progress_within_5_minutes: Schema.Boolean,
  verdict: EvidenceVerdictSchema,
});

const MultiDeviceArtifactSchema = Schema.Struct({
  converged: Schema.Boolean,
  ordering_violations: Schema.Number,
  stream_duplicates: Schema.Number,
  stream_gaps: Schema.Number,
  verdict: EvidenceVerdictSchema,
});

const RequestCountArtifactSchema = Schema.Struct({
  timeSeries: Schema.Array(
    Schema.Struct({
      metric: Schema.Struct({
        labels: Schema.Struct({ response_code: Schema.optionalKey(Schema.String) }),
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

  let total = 0;
  let observedSeries = false;
  for (const listed of requestCountFiles) {
    const parsed = decodeArtifact(RequestCountArtifactSchema, files.get(listed), listed);
    if (parsed === undefined || parsed.timeSeries.length === 0) continue;
    observedSeries = true;
    for (const item of parsed.timeSeries) {
      if (item.metric.labels.response_code !== "429") continue;
      for (const point of item.points) {
        const raw = point.value.int64Value;
        if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
          throw new EvidenceImportError(
            "MALFORMED_ARTIFACT",
            listed,
            "request-count point is not a non-negative integer",
          );
        }
        const value = Number(raw);
        if (!Number.isSafeInteger(value)) {
          throw new EvidenceImportError(
            "MALFORMED_ARTIFACT",
            listed,
            "request-count point exceeds safe integer range",
          );
        }
        total += value;
      }
    }
  }
  return observedSeries ? total : undefined;
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
  if (!Number.isFinite(milliseconds)) {
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
  if (input.qualifying !== undefined && typeof input.qualifying !== "boolean") {
    throw new EvidenceImportError("INVALID_REQUEST", input.run, "qualifying must be boolean");
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

  const lane = scenarioArtifact?.lane;
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
  const completed = auditArtifact?.completed_root_outcomes ?? auditArtifact?.good_root_outcomes;
  const correct = auditArtifact?.good_root_outcomes;
  const receiptWithinOneSecondRatio = qualReceipt?.within_1_second_ratio;
  const receiptStatus: GateStatus =
    receiptWithinOneSecondRatio === undefined
      ? "MISSING"
      : receiptWithinOneSecondRatio >= 0.999
        ? "PASS"
        : "FAIL";
  const reconciliationStatus = statusFrom(qualReconciliation?.verdict ?? auditArtifact?.verdict);
  const offeredAcceptedStatus: GateStatus =
    offered === undefined || accepted === undefined
      ? "MISSING"
      : offered === accepted
        ? "PASS"
        : "FAIL";
  const correctnessStatus = reconciliationStatus;
  const firstMeaningfulEventStatus = statusFrom(firstMeaningfulEventArtifact?.verdict);
  const recoveryStatus: GateStatus =
    recoveryArtifact === undefined
      ? "MISSING"
      : recoveryArtifact.verdict === "PASS" &&
          recoveryArtifact.backlog_bounded &&
          recoveryArtifact.progress_within_5_minutes &&
          recoveryArtifact.full_drain_within_20_minutes
        ? "PASS"
        : "FAIL";
  const multiDeviceStatus: GateStatus =
    multiDeviceArtifact === undefined
      ? "MISSING"
      : multiDeviceArtifact.verdict === "PASS" &&
          multiDeviceArtifact.converged &&
          multiDeviceArtifact.ordering_violations === 0 &&
          multiDeviceArtifact.stream_duplicates === 0 &&
          multiDeviceArtifact.stream_gaps === 0
        ? "PASS"
        : "FAIL";
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

  const region =
    input.region ?? scenarioArtifact?.region ?? qualificationArtifact?.region ?? "unspecified";
  validateBoundedSlug(region, "region", input.run);
  const topology = input.topology ?? topologyFrom(scenarioArtifact);
  const cell = input.cell ?? cellFrom(lane);
  const history = input.history ?? historyFrom(lane);
  const wal =
    input.wal ??
    scenarioArtifact?.database_wal_envelope ??
    qualificationArtifact?.wal_envelope ??
    "unspecified";
  validateBoundedSlug(topology, "topology", input.run);
  validateBoundedSlug(history, "history", input.run);
  validateBoundedSlug(wal, "wal", input.run);
  if (!["A", "B", "C", "D", "none"].includes(cell)) {
    throw new EvidenceImportError("MALFORMED_ARTIFACT", "scenario.json", "matrix cell is invalid");
  }
  const qualifying = input.qualifying === true && region === selectedRegion;

  return {
    run: input.run,
    classification: input.classification,
    qualifying,
    sourceHash: verified.sourceHash,
    region,
    topology,
    cell,
    history,
    wal,
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
    admissionStatus: offeredAcceptedStatus,
    reconciliationStatus,
    receiptStatus,
    firstMeaningfulEventStatus,
    recoveryStatus,
    multiDeviceStatus,
    overallStatus,
    artifactStatuses,
    integrityViolations: {
      duplicate_publications: auditArtifact?.duplicate_publications,
      duplicate_terminal_commits: auditArtifact?.duplicate_terminal_commits,
      ghost_delivery_attempts: auditArtifact?.ghost_delivery_attempts,
      nonterminal_agent_runs: auditArtifact?.nonterminal_agent_runs,
      stranded_accepted_runs: auditArtifact?.stranded_accepted_runs,
      unfinished_agent_run_attempts: auditArtifact?.unfinished_agent_run_attempts,
      unfinished_model_call_attempts: auditArtifact?.unfinished_model_call_attempts,
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
    const summary =
      run.overallStatus === "PASS"
        ? "qualified"
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
          ? "selected-region-qualifying"
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
    );

    const requirementGroups: ReadonlyArray<readonly [string, ReadonlyArray<string>, GateStatus]> = [
      [
        "recovery",
        [
          "dependency_outage",
          "backlog_accumulation",
          "recovery_rate",
          "drain_time",
          "process_cut_timeline",
        ],
        run.recoveryStatus,
      ],
      [
        "multi_device",
        [
          "concurrent_sse_connections",
          "device_cursor_positions",
          "stream_gaps",
          "stream_duplicates",
          "stream_ordering",
          "replay_latency",
          "device_convergence",
        ],
        run.multiDeviceStatus,
      ],
      [
        "qualification",
        [
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
        ],
        "MISSING",
      ],
    ];
    for (const [view, requirements, status] of requirementGroups) {
      for (const requirement of requirements) {
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
  const starts = runs.flatMap((run) => (run.startedAt === undefined ? [] : [run.startedAt])).sort();
  const ends = runs.flatMap((run) => (run.endedAt === undefined ? [] : [run.endedAt])).sort();
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
  if (await exists(target)) return realpath(target);
  const parent = await realpath(dirname(target));
  return resolve(parent, basename(target));
};

const assertOutputsOutsideEvidenceRoots = async (
  bundles: ReadonlyArray<EvidenceBundleInput>,
  outputPaths: ReadonlyArray<string>,
) => {
  const roots = await Promise.all(bundles.map((bundle) => realpath(resolve(bundle.root))));
  const targets = await Promise.all(outputPaths.map(canonicalOutputTarget));
  if (new Set(targets).size !== targets.length) {
    throw new EvidenceImportError("INVALID_REQUEST", "outputs", "output paths must be distinct");
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
  )(await readFile(resolve(manifestPath), "utf8"));
  if (Exit.isFailure(decodedRequest)) {
    throw new EvidenceImportError(
      "INVALID_REQUEST",
      manifestPath,
      "manifest does not match the evidence import schema",
    );
  }
  const request = decodedRequest.value;
  await assertOutputsOutsideEvidenceRoots(request.bundles, [
    outputPath,
    openMetricsPath,
    reportPath,
  ]);
  const result = await importEvidenceBundles(request);
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
