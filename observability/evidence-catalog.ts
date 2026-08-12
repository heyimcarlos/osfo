import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { Exit, Schema } from "effect";

const StatusSchema = Schema.Literals(["PASS", "FAIL", "MISSING"]);
const AdapterSchema = Schema.Literals([
  "packet-index",
  "evidence-markdown",
  "packet-runs",
  "matrix-summary",
  "receipt-slo",
  "development-runtime",
  "development-sse",
  "development-cloud",
  "github-context",
  "prototype-result",
  "directory-inventory",
  "file-inventory",
]);
const DispositionSchema = Schema.Literals(["import", "represent", "link", "exclude"]);

const ManifestSourceSchema = Schema.Struct({
  id: Schema.String,
  adapter: AdapterSchema,
  category: Schema.String,
  path: Schema.String,
  publicUrl: Schema.NullOr(Schema.String),
  structure: Schema.String,
  seal: Schema.String,
  scope: Schema.String,
  disposition: DispositionSchema,
  exclusionReason: Schema.NullOr(Schema.String),
  issueOrRequirement: Schema.Array(Schema.String),
  required: Schema.Boolean,
  status: Schema.optionalKey(StatusSchema),
});

export const EvidenceCatalogManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  repositoryUrl: Schema.String,
  sources: Schema.Array(ManifestSourceSchema),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

type GateStatus = typeof StatusSchema.Type;
type ManifestSource = typeof ManifestSourceSchema.Type;
export type EvidenceCatalogManifest = typeof EvidenceCatalogManifestSchema.Type;

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const isJsonObject: (value: Schema.Json | undefined) => value is Schema.JsonObject =
  Schema.is(JsonObjectSchema);
const isJsonString: (value: Schema.Json | undefined) => value is string = Schema.is(Schema.String);
const isJsonNumber: (value: Schema.Json | undefined) => value is number = Schema.is(Schema.Number);
const isJsonBoolean: (value: Schema.Json | undefined) => value is boolean = Schema.is(
  Schema.Boolean,
);

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const textValue = (record: Schema.JsonObject, key: string) => {
  const value = record[key];
  return isJsonString(value) ? value : undefined;
};

const numberValue = (record: Schema.JsonObject, key: string) => {
  const value = record[key];
  return isJsonNumber(value) && Number.isFinite(value) ? value : undefined;
};

const recordValue = (record: Schema.JsonObject, key: string) => {
  const value = record[key];
  return isJsonObject(value) ? value : undefined;
};

const statusValue = (value: Schema.Json | undefined): GateStatus =>
  value === "PASS" || value === "FAIL" || value === "MISSING" ? value : "MISSING";

const minStatus = (values: ReadonlyArray<GateStatus>): GateStatus =>
  values.includes("FAIL") ? "FAIL" : values.includes("MISSING") ? "MISSING" : "PASS";

const slug = (value: string) => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80);
  return normalized.length === 0 ? "record" : normalized;
};

export class EvidenceCatalogError extends Error {
  readonly code:
    | "INVALID_MANIFEST"
    | "INVALID_SOURCE"
    | "CHECKSUM_MISMATCH"
    | "DUPLICATE_ID"
    | "UNSAFE_OUTPUT";
  readonly sourcePath: string;

  constructor(code: EvidenceCatalogError["code"], sourcePath: string, detail: string) {
    super(`${code}: ${sourcePath}: ${detail}`);
    this.name = "EvidenceCatalogError";
    this.code = code;
    this.sourcePath = sourcePath;
  }
}

export interface CatalogFact {
  readonly domain:
    | "workload"
    | "outcome"
    | "latency"
    | "provider"
    | "postgres"
    | "fleet"
    | "recovery"
    | "sse"
    | "toolcall"
    | "action"
    | "context";
  readonly name: string;
  readonly status: GateStatus;
  readonly value: number | string | boolean | null;
  readonly unit: string | null;
}

export interface CatalogRequirement {
  readonly issue: string;
  readonly requirement: string;
  readonly status: GateStatus;
  readonly explanation: string;
}

export interface CatalogRecord {
  readonly id: string;
  readonly alias: string;
  readonly sourceId: string;
  readonly category: string;
  readonly kind: string;
  readonly run: string | null;
  readonly issue: string | null;
  readonly gate: string;
  readonly utc: { readonly start: string | null; readonly end: string | null };
  readonly region: string;
  readonly topology: string;
  readonly environment: string;
  readonly classification: "current" | "historical" | "contextual" | "derived";
  readonly qualificationScope: "production" | "development" | "historical" | "contextual";
  readonly status: GateStatus;
  readonly disposition: typeof DispositionSchema.Type;
  readonly facts: ReadonlyArray<CatalogFact>;
  readonly requirements: ReadonlyArray<CatalogRequirement>;
  readonly authority: string;
  readonly checksum: string | null;
  readonly link: string | null;
  readonly explanation: string;
  readonly limitations: ReadonlyArray<string>;
}

export interface CoverageRecord {
  readonly sourceId: string;
  readonly category: string;
  readonly path: string;
  readonly publicUrl: string | null;
  readonly count: number;
  readonly structure: string;
  readonly seal: string;
  readonly scope: string;
  readonly disposition: typeof DispositionSchema.Type;
  readonly exclusionReason: string | null;
  readonly issueOrRequirement: ReadonlyArray<string>;
  readonly integrityProvenance: string;
}

export interface EvidenceCatalogResult {
  readonly catalog: ReadonlyArray<CatalogRecord>;
  readonly coverage: ReadonlyArray<CoverageRecord>;
  readonly metrics: string;
  readonly openMetrics: string;
  readonly importReport: {
    readonly schemaVersion: 1;
    readonly sourceCount: number;
    readonly recordCount: number;
    readonly statusCounts: Readonly<Record<GateStatus, number>>;
    readonly utcRange: { readonly from: string; readonly to: string } | null;
  };
}

interface CompilerContext {
  readonly repoRoot: string;
  readonly packetDirectory: string;
  readonly artifacts: ReadonlyMap<string, IndexedArtifact>;
  readonly verifiedArtifactBytes: ReadonlyMap<string, Buffer>;
}

interface AdapterResult {
  readonly records: ReadonlyArray<CatalogRecord>;
  readonly count: number;
  readonly integrityProvenance: string;
}

interface IndexedArtifact {
  readonly id: string;
  readonly kind: string;
  readonly artifactStatus: GateStatus;
  readonly evidenceStatus: GateStatus;
  readonly path: string | null;
  readonly sha256: string | null;
  readonly description: string;
  readonly source: string | undefined;
  readonly sourceManifestSha256: string | undefined;
  readonly sourceManifestPath: string | undefined;
}

const unsafePathPattern = /(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|node_modules(?:\/|$))/u;

const assertSafeRelativePath = (path: string, label: string) => {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").includes("..") ||
    unsafePathPattern.test(path) ||
    /(?:^|\/)home(?:\/|$)/u.test(path)
  ) {
    throw new EvidenceCatalogError(
      "INVALID_MANIFEST",
      label,
      "path must be safe and repo-relative",
    );
  }
};

const isInside = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);

const sourceAbsolutePath = (repoRoot: string, source: ManifestSource) => {
  assertSafeRelativePath(source.path, source.id);
  const absolute = resolve(repoRoot, source.path);
  if (!isInside(repoRoot, absolute)) {
    throw new EvidenceCatalogError("INVALID_MANIFEST", source.path, "path escapes repository");
  }
  return absolute;
};

const safePublicUrl = (value: string | null) => {
  if (value === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new EvidenceCatalogError("INVALID_MANIFEST", "publicUrl", "URL is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new EvidenceCatalogError("INVALID_MANIFEST", "publicUrl", "URL must use HTTP or HTTPS");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new EvidenceCatalogError(
      "INVALID_MANIFEST",
      "publicUrl",
      "URL credentials are forbidden",
    );
  }
  return value;
};

const readRegularFile = async (root: string, path: string) => {
  const canonical = await realpath(path).catch(() => {
    throw new EvidenceCatalogError("INVALID_SOURCE", relative(root, path), "source is missing");
  });
  if (!isInside(root, canonical)) {
    throw new EvidenceCatalogError(
      "INVALID_SOURCE",
      relative(root, path),
      "source escapes repository",
    );
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new EvidenceCatalogError(
      "INVALID_SOURCE",
      relative(root, path),
      "source must be a regular file",
    );
  }
  return readFile(canonical);
};

const decodeJson = async (repoRoot: string, path: string): Promise<Schema.Json> => {
  const bytes = await readRegularFile(repoRoot, path);
  return decodeJsonBytes(bytes, relative(repoRoot, path));
};

const decodeJsonBytes = (bytes: Buffer, path: string): Schema.Json => {
  const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Json))(
    bytes.toString("utf8"),
  );
  if (Exit.isFailure(decoded)) {
    throw new EvidenceCatalogError("INVALID_SOURCE", path, "invalid JSON");
  }
  return decoded.value;
};

const requiredRecord = (value: Schema.Json, path: string): Schema.JsonObject => {
  if (!isJsonObject(value)) {
    throw new EvidenceCatalogError("INVALID_SOURCE", path, "expected a JSON object");
  }
  return value;
};

const validateManifest = async (manifestPath: string) => {
  const bytes = await readFile(manifestPath).catch(() => {
    throw new EvidenceCatalogError("INVALID_MANIFEST", manifestPath, "manifest is unreadable");
  });
  const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(EvidenceCatalogManifestSchema))(
    bytes.toString("utf8"),
  );
  if (Exit.isFailure(decoded)) {
    throw new EvidenceCatalogError("INVALID_MANIFEST", manifestPath, "manifest schema is invalid");
  }
  const ids = new Set<string>();
  for (const source of decoded.value.sources) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(source.id)) {
      throw new EvidenceCatalogError(
        "INVALID_MANIFEST",
        source.id,
        "source id is not a bounded slug",
      );
    }
    if (ids.has(source.id)) {
      throw new EvidenceCatalogError("DUPLICATE_ID", source.id, "source id is duplicated");
    }
    ids.add(source.id);
    safePublicUrl(source.publicUrl);
    if (source.disposition === "exclude" && source.exclusionReason === null) {
      throw new EvidenceCatalogError(
        "INVALID_MANIFEST",
        source.id,
        "excluded sources require an exclusion reason",
      );
    }
  }
  return decoded.value;
};

const indexedArtifactFrom = (value: Schema.Json): IndexedArtifact => {
  const record = requiredRecord(value, "artifact-index.json");
  const artifactStatus = statusValue(record.artifactStatus);
  const evidenceStatus = statusValue(record.evidenceStatus);
  const id = textValue(record, "id");
  const kind = textValue(record, "kind");
  const description = textValue(record, "description");
  if (id === undefined || kind === undefined || description === undefined) {
    throw new EvidenceCatalogError(
      "INVALID_SOURCE",
      "artifact-index.json",
      "artifact is incomplete",
    );
  }
  const path = record.path === null ? null : textValue(record, "path");
  const digest = record.sha256 === null ? null : textValue(record, "sha256");
  const source = textValue(record, "source");
  const sourceManifestSha256 = textValue(record, "sourceManifestSha256");
  const sourceManifestPath = textValue(record, "sourceManifestPath");
  if (
    (artifactStatus === "MISSING" && (path !== null || digest !== null)) ||
    (artifactStatus !== "MISSING" && (path === undefined || digest === undefined)) ||
    (digest !== null && digest !== undefined && !/^[a-f0-9]{64}$/u.test(digest))
  ) {
    throw new EvidenceCatalogError(
      "INVALID_SOURCE",
      id,
      "artifact presence fields contradict status",
    );
  }
  return {
    id,
    kind,
    artifactStatus,
    evidenceStatus,
    path: path ?? null,
    sha256: digest ?? null,
    description,
    source,
    sourceManifestSha256,
    sourceManifestPath,
  };
};

const verifyArtifactIndex = async (repoRoot: string, indexPath: string) => {
  const raw = requiredRecord(await decodeJson(repoRoot, indexPath), relative(repoRoot, indexPath));
  if (
    raw.schemaVersion !== 1 ||
    raw.packet !== "openpoke-v1-demo" ||
    !Array.isArray(raw.artifacts)
  ) {
    throw new EvidenceCatalogError(
      "INVALID_SOURCE",
      relative(repoRoot, indexPath),
      "index header is invalid",
    );
  }
  const packetDirectory = dirname(indexPath);
  const byPath = new Map<string, IndexedArtifact>();
  const verifiedArtifactBytes = new Map<string, Buffer>();
  const ids = new Set<string>();
  const manifestContents = new Map<string, string>();
  for (const value of raw.artifacts) {
    const artifact = indexedArtifactFrom(value);
    if (ids.has(artifact.id)) {
      throw new EvidenceCatalogError("DUPLICATE_ID", artifact.id, "artifact id is duplicated");
    }
    ids.add(artifact.id);
    if (artifact.path === null || artifact.sha256 === null) {
      byPath.set(`@missing/${artifact.id}`, artifact);
      continue;
    }
    assertSafeRelativePath(artifact.path, artifact.id);
    if (byPath.has(artifact.path)) {
      throw new EvidenceCatalogError("DUPLICATE_ID", artifact.path, "artifact path is duplicated");
    }
    const bytes = await readRegularFile(repoRoot, resolve(packetDirectory, artifact.path));
    if (sha256(bytes) !== artifact.sha256) {
      throw new EvidenceCatalogError(
        "CHECKSUM_MISMATCH",
        artifact.path,
        "artifact sha256 differs from index",
      );
    }
    byPath.set(artifact.path, artifact);
    verifiedArtifactBytes.set(artifact.path, bytes);
    if (artifact.kind === "source-manifest") {
      manifestContents.set(artifact.sha256, bytes.toString("utf8"));
    }
  }
  for (const artifact of byPath.values()) {
    if (artifact.sourceManifestSha256 === undefined && artifact.sourceManifestPath === undefined) {
      continue;
    }
    if (artifact.sourceManifestSha256 === undefined || artifact.sourceManifestPath === undefined) {
      throw new EvidenceCatalogError(
        "INVALID_SOURCE",
        artifact.id,
        "source provenance is incomplete",
      );
    }
    const manifest = manifestContents.get(artifact.sourceManifestSha256);
    if (manifest === undefined) {
      throw new EvidenceCatalogError(
        "INVALID_SOURCE",
        artifact.id,
        "source manifest is not indexed",
      );
    }
    const expected = `${artifact.sha256}  ${artifact.sourceManifestPath}`;
    if (!manifest.split(/\r?\n/gu).includes(expected)) {
      throw new EvidenceCatalogError(
        "CHECKSUM_MISMATCH",
        artifact.id,
        "source manifest entry differs",
      );
    }
  }
  return {
    artifacts: byPath,
    packetDirectory,
    count: raw.artifacts.length,
    verifiedArtifactBytes,
  };
};

const baseRecord = (
  source: ManifestSource,
  fields: Partial<CatalogRecord> & Pick<CatalogRecord, "id" | "alias" | "status">,
): CatalogRecord => ({
  id: fields.id,
  alias: fields.alias,
  sourceId: source.id,
  category: fields.category ?? source.category,
  kind: fields.kind ?? source.adapter,
  run: fields.run ?? null,
  issue: fields.issue ?? null,
  gate: fields.gate ?? "evidence",
  utc: fields.utc ?? { start: null, end: null },
  region: fields.region ?? "unspecified",
  topology: fields.topology ?? "unspecified",
  environment: fields.environment ?? "contextual",
  classification: fields.classification ?? "contextual",
  qualificationScope: fields.qualificationScope ?? "contextual",
  status: fields.status,
  disposition: fields.disposition ?? source.disposition,
  facts: fields.facts ?? [],
  requirements: fields.requirements ?? [],
  authority: fields.authority ?? source.seal,
  checksum: fields.checksum ?? null,
  link: fields.link ?? safePublicUrl(source.publicUrl),
  explanation: fields.explanation ?? source.structure,
  limitations:
    fields.limitations ?? (source.exclusionReason === null ? [] : [source.exclusionReason]),
});

const fact = (
  domain: CatalogFact["domain"],
  name: string,
  value: number | string | boolean | null,
  unit: string | null = null,
  status: GateStatus = value === null ? "MISSING" : "PASS",
): CatalogFact => ({ domain, name, status, value, unit });

const numericFacts = (
  domain: CatalogFact["domain"],
  record: Schema.JsonObject | undefined,
  fields: ReadonlyArray<readonly [string, string, string | null]>,
) =>
  fields.flatMap(([key, name, unit]) => {
    const value = record === undefined ? undefined : numberValue(record, key);
    return value === undefined ? [] : [fact(domain, name, value, unit)];
  });

const artifactScope = (artifact: IndexedArtifact) => {
  const path = artifact.path ?? "";
  if (/evidence\/(?:final-us-east4|runs\/matrix-)/u.test(path)) {
    return {
      environment: "production",
      classification: "current" as const,
      qualificationScope: "production" as const,
    };
  }
  if (path.startsWith("assets/")) {
    return {
      environment: "derived-presentation",
      classification: "derived" as const,
      qualificationScope: "contextual" as const,
    };
  }
  return {
    environment: "non-production",
    classification: "historical" as const,
    qualificationScope: "historical" as const,
  };
};

const packetIndexAdapter = async (
  source: ManifestSource,
  context: CompilerContext,
): Promise<AdapterResult> => {
  const records = [...context.artifacts.values()].map((artifact) => {
    const scope = artifactScope(artifact);
    const placeholderGate =
      artifact.id === "production-saturation-bundle"
        ? "saturation"
        : artifact.id === "full-outage-recovery-bundle"
          ? "full_outage_recovery"
          : artifact.id === "production-external-action-proof"
            ? "action_receipt"
            : artifact.id === "complete-production-cost"
              ? "complete_cost"
              : artifact.id === "authenticated-three-tab-recording"
                ? "three_tab_resume"
                : "evidence";
    const productionPlaceholder = [
      "saturation",
      "full_outage_recovery",
      "action_receipt",
      "complete_cost",
    ].includes(placeholderGate);
    return baseRecord(source, {
      id: `packet-${slug(artifact.id)}`,
      alias: artifact.id.replaceAll("-", " "),
      status: artifact.evidenceStatus,
      kind: artifact.kind,
      ...(productionPlaceholder
        ? {
            environment: "production",
            classification: "current" as const,
            qualificationScope: "production" as const,
          }
        : scope),
      gate: placeholderGate,
      checksum: artifact.sha256,
      link:
        artifact.source === undefined
          ? artifact.path === null
            ? source.publicUrl
            : `${source.publicUrl?.replace(/artifact-index\.json$/u, "") ?? ""}${artifact.path}`
          : artifact.source,
      authority:
        artifact.sourceManifestSha256 === undefined
          ? "artifact-index-checksum"
          : "artifact-index-and-source-manifest-entry",
      explanation: artifact.description,
      limitations:
        artifact.artifactStatus === "MISSING"
          ? ["The artifact is explicitly absent and has no path or checksum."]
          : [],
      requirements:
        artifact.id === "production-external-action-proof"
          ? [
              "production action receipt",
              "attempt before contact",
              "lost ack reconciliation",
              "exactly one effect",
            ].map((requirement) => ({
              issue: "68",
              requirement,
              status: "MISSING" as const,
              explanation: "No sealed production external Action proof exists.",
            }))
          : [],
    });
  });
  records.push(
    baseRecord(source, {
      id: "catalog-integrity",
      alias: "Catalog integrity",
      status: "PASS",
      category: "evidence-catalog-provenance",
      gate: "catalog_integrity",
      environment: "contextual",
      classification: "derived",
      qualificationScope: "contextual",
      authority: "artifact-index-verification",
      explanation:
        "All present indexed artifact checksums and declared source-manifest entries verified.",
      limitations: ["Catalog integrity does not establish product qualification."],
    }),
  );
  return {
    records,
    count: records.length - 1,
    integrityProvenance:
      "Every present artifact sha256 and available source-manifest entry verified.",
  };
};

const splitTableRow = (line: string) =>
  line
    .slice(1, line.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());

const plainMarkdown = (value: string) =>
  value
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[`*_]/gu, "")
    .replace(/<[^>]+>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

const evidenceMarkdownAdapter = async (
  source: ManifestSource,
  context: CompilerContext,
  path: string,
): Promise<AdapterResult> => {
  const markdown = (await readRegularFile(context.repoRoot, path)).toString("utf8");
  const lines = markdown.split(/\r?\n/gu);
  let section = "Evidence";
  const rows: Array<{ section: string; cells: string[] }> = [];
  for (const line of lines) {
    const heading = /^##\s+(.+)$/u.exec(line);
    if (heading?.[1] !== undefined) section = plainMarkdown(heading[1]);
    if (!line.startsWith("|")) continue;
    const cells = splitTableRow(line);
    const first = cells[0] ?? "";
    if (
      cells.length < 2 ||
      /^(?:-+:?|Step|Requirement|Input)$/iu.test(first) ||
      cells.every((cell) => /^:?-+:?$/u.test(cell))
    ) {
      continue;
    }
    rows.push({ section, cells });
  }
  const records: CatalogRecord[] = [];
  for (const [index, row] of rows.entries()) {
    const alias = plainMarkdown(row.cells[0] ?? `row ${index + 1}`);
    const explicitStatus = row.cells.find(
      (cell): cell is GateStatus => cell === "PASS" || cell === "FAIL" || cell === "MISSING",
    );
    const links = [...row.cells.join(" ").matchAll(/\]\(([^)]+)\)/gu)].map((match) => match[1]!);
    const limitations: string[] = [];
    for (const link of links) {
      if (/^https?:\/\//u.test(link)) continue;
      const withoutAnchor = decodeURIComponent(link.split("#", 1)[0] ?? "");
      const absolute = resolve(dirname(path), withoutAnchor);
      if (!isInside(context.repoRoot, absolute)) {
        throw new EvidenceCatalogError("INVALID_SOURCE", link, "narrative link escapes repository");
      }
      await access(absolute).catch(() => {
        throw new EvidenceCatalogError("INVALID_SOURCE", link, "narrative link target is missing");
      });
      const packetRelative = relative(context.packetDirectory, absolute).split(sep).join("/");
      const indexed = context.artifacts.get(packetRelative);
      const indexedDirectory = [...context.artifacts.keys()].some((path) =>
        path.startsWith(`${packetRelative.replace(/\/$/u, "")}/`),
      );
      if (
        isInside(context.packetDirectory, absolute) &&
        indexed === undefined &&
        !indexedDirectory
      ) {
        throw new EvidenceCatalogError(
          "INVALID_SOURCE",
          link,
          "packet-local narrative link is neither indexed structured evidence nor an indexed artifact",
        );
      }
      limitations.push(
        indexed === undefined && !indexedDirectory
          ? `Context link: ${relative(context.repoRoot, absolute).split(sep).join("/")}`
          : indexed === undefined
            ? `Artifact context directory: ${packetRelative}`
            : `${indexed.kind === "sealed-run" ? "Structured evidence" : "Artifact context"}: ${indexed.id}`,
      );
    }
    records.push(
      baseRecord(source, {
        id: `narrative-${String(index + 1).padStart(2, "0")}-${slug(alias)}`,
        alias,
        status: explicitStatus ?? "MISSING",
        gate: slug(alias),
        environment: "mixed",
        classification: "contextual",
        qualificationScope: "contextual",
        authority: "narrative-coverage-only",
        facts: [fact("context", "table_row_present", true)],
        explanation: `${row.section}: ${plainMarkdown(row.cells.slice(1).join(" | "))}`,
        limitations:
          explicitStatus === undefined
            ? [
                "This is a configuration or arithmetic context row, not a qualification gate.",
                ...limitations,
              ]
            : limitations,
      }),
    );
  }
  return {
    records,
    count: records.length,
    integrityProvenance:
      "Every Markdown table row parsed; every local link resolved to indexed evidence or explicit repository context.",
  };
};

const indexedJson = async (context: CompilerContext, path: string) => {
  const packetRelative = relative(context.packetDirectory, path).split(sep).join("/");
  const artifact = context.artifacts.get(packetRelative);
  if (artifact === undefined || artifact.sha256 === null) {
    throw new EvidenceCatalogError(
      "INVALID_SOURCE",
      packetRelative,
      "structured packet JSON is not indexed",
    );
  }
  const bytes = context.verifiedArtifactBytes.get(packetRelative);
  if (bytes === undefined) {
    throw new EvidenceCatalogError(
      "INVALID_SOURCE",
      packetRelative,
      "verified artifact bytes are unavailable",
    );
  }
  return {
    artifact,
    value: requiredRecord(decodeJsonBytes(bytes, packetRelative), packetRelative),
  };
};

const runFacts = (
  scenario: Schema.JsonObject,
  audit: Schema.JsonObject | undefined,
  caller: Schema.JsonObject | undefined,
) => {
  const callerLatency = caller === undefined ? undefined : recordValue(caller, "latency_ms");
  const receiptLatency =
    audit === undefined ? undefined : recordValue(audit, "caller_to_receipt_ms");
  const deliveryClaim =
    audit === undefined ? undefined : recordValue(audit, "delivery_to_claim_ms");
  const duplicateTerminalCommits =
    audit === undefined ? undefined : numberValue(audit, "duplicate_terminal_commits");
  const releaseCounters = [
    "inflight_agent_run_budget_obligations",
    "inflight_agent_run_budget_used",
    "inflight_agent_run_budget_mismatch",
    "principal_budget_obligations",
    "principal_budget_used",
    "principal_budget_mismatch",
  ].map((key) => (audit === undefined ? undefined : numberValue(audit, key)));
  return [
    ...numericFacts("workload", scenario, [
      ["rate_per_second", "rate_per_second", "per_second"],
      ["duration_seconds", "duration_seconds", "seconds"],
      ["count", "offered", "commands"],
    ]),
    ...numericFacts("fleet", scenario, [
      ["worker_fixed_instances", "worker_instances", "instances"],
      ["worker_pull_streams", "streams_per_worker", "streams"],
      ["worker_slots", "slots_per_worker", "slots"],
      ["worker_db_pool", "database_pool_per_worker", "connections"],
    ]),
    ...numericFacts("outcome", audit, [
      ["accepted_incoming", "accepted", "commands"],
      ["expected_incoming", "expected", "commands"],
      ["good_root_outcomes", "correct_root_outcomes", "commands"],
      ["succeeded_agent_runs", "succeeded_agent_runs", "agent_runs"],
      ["total", "completed_agent_runs", "agent_runs"],
      ["succeeded", "succeeded_agent_runs", "agent_runs"],
    ]),
    ...numericFacts("recovery", audit, [
      ["duplicate_terminal_commits", "duplicate_terminal_commits", "commits"],
      ["unfinished_agent_run_attempts", "unfinished_agent_run_attempts", "attempts"],
      ["nonterminal_agent_runs", "nonterminal_agent_runs", "agent_runs"],
      ["stranded_accepted_runs", "stranded_accepted_runs", "agent_runs"],
      ["inflight_agent_run_budget_obligations", "inflight_budget_obligations", "reservations"],
      ["inflight_agent_run_budget_used", "inflight_budget_used", "reservations"],
      ["inflight_agent_run_budget_mismatch", "inflight_budget_mismatch", "reservations"],
      ["principal_budget_obligations", "principal_budget_obligations", "reservations"],
      ["principal_budget_used", "principal_budget_used", "reservations"],
      ["principal_budget_mismatch", "principal_budget_mismatch", "reservations"],
    ]),
    ...(audit === undefined
      ? []
      : [
          fact(
            "recovery",
            "terminal_uniqueness",
            duplicateTerminalCommits === undefined ? null : duplicateTerminalCommits === 0,
          ),
          fact(
            "recovery",
            "capacity_reservations_released",
            releaseCounters.some((value) => value === undefined)
              ? null
              : releaseCounters.every((value) => value === 0),
          ),
        ]),
    ...numericFacts("latency", callerLatency ?? receiptLatency, [
      ["p50", "receipt_p50_ms", "milliseconds"],
      ["p95", "receipt_p95_ms", "milliseconds"],
      ["p99", "receipt_p99_ms", "milliseconds"],
      ["max", "receipt_max_ms", "milliseconds"],
    ]),
    ...numericFacts("latency", deliveryClaim, [
      ["p95", "delivery_to_claim_p95_ms", "milliseconds"],
      ["p99", "delivery_to_claim_p99_ms", "milliseconds"],
    ]),
  ];
};

const packetRunsAdapter = async (
  source: ManifestSource,
  context: CompilerContext,
  root: string,
): Promise<AdapterResult> => {
  const entries = await readdir(root, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  if (entries.some((entry) => entry.isSymbolicLink())) {
    throw new EvidenceCatalogError(
      "INVALID_SOURCE",
      source.path,
      "run directory contains a symlink",
    );
  }
  const records: CatalogRecord[] = [];
  for (const directory of directories) {
    const runRoot = resolve(root, directory.name);
    const scenarioPath = resolve(runRoot, "scenario.json");
    const scenarioIndexed = await indexedJson(context, scenarioPath);
    const scenario = scenarioIndexed.value;
    const optionalJson = async (name: string) => {
      const path = resolve(runRoot, name);
      try {
        return (await indexedJson(context, path)).value;
      } catch (cause) {
        if (cause instanceof EvidenceCatalogError && cause.code === "INVALID_SOURCE")
          return undefined;
        throw cause;
      }
    };
    const audit = await optionalJson("audit.json");
    const caller = await optionalJson("caller-summary.json");
    const packetPrefix = `evidence/runs/${directory.name}/`;
    const statuses = [...context.artifacts.entries()]
      .filter(([path]) => path.startsWith(packetPrefix))
      .map(([, artifact]) => artifact.evidenceStatus);
    const matrix = /^matrix-[A-D]-/u.test(directory.name);
    const recovery = /^recovery-rate-(\d+)-workers-(\d+)$/u.exec(directory.name);
    const workerDelivery = textValue(scenario, "worker_delivery");
    records.push(
      baseRecord(source, {
        id: `run-${slug(directory.name)}`,
        alias:
          recovery === null
            ? directory.name.replaceAll("-", " ")
            : `${recovery[2]}-worker recovery at ${recovery[1]}/s`,
        run: directory.name,
        category: "packet-run",
        status: statuses.length === 0 ? "MISSING" : minStatus(statuses),
        gate:
          directory.name === "worker-loss-before-claim"
            ? "before_claim_loss"
            : directory.name === "worker-loss-after-claim"
              ? "after_claim_loss"
              : directory.name.startsWith("recovery-rate-")
                ? "recovery_rate_screen"
                : (textValue(scenario, "lane") ?? directory.name),
        utc: {
          start: textValue(scenario, "started_at") ?? null,
          end: textValue(scenario, "ended_at") ?? null,
        },
        region: textValue(scenario, "region") ?? (matrix ? "us-east4" : "unspecified"),
        topology: workerDelivery === "pull" ? "streaming-pull" : "unspecified",
        environment: matrix ? "production" : "non-production",
        classification: matrix ? "current" : "historical",
        qualificationScope: matrix ? "production" : "historical",
        authority: "packet-copy-with-source-manifest-entry-provenance",
        checksum: scenarioIndexed.artifact.sha256,
        facts: runFacts(scenario, audit, caller),
        explanation: `Packet run ${directory.name}. Copied files are individually verified against the artifact index and original source manifest.`,
        limitations: matrix
          ? [
              "The copied run directory is incomplete; final cell facts come from the authoritative stable matrix summary.",
            ]
          : ["Non-production evidence cannot qualify production."],
      }),
    );
  }
  return {
    records,
    count: directories.length,
    integrityProvenance:
      "Every direct run directory represented; every copied JSON verified through artifact-index and source-manifest provenance.",
  };
};

const matrixSummaryAdapter = async (
  source: ManifestSource,
  context: CompilerContext,
  path: string,
): Promise<AdapterResult> => {
  const indexed = await indexedJson(context, path);
  const cells = recordValue(indexed.value, "cells");
  if (cells === undefined) {
    throw new EvidenceCatalogError("INVALID_SOURCE", source.path, "matrix cells are absent");
  }
  const records: CatalogRecord[] = [];
  for (const cellName of ["A", "B", "C", "D"] as const) {
    const cell = recordValue(cells, cellName);
    if (cell === undefined) {
      throw new EvidenceCatalogError(
        "INVALID_SOURCE",
        source.path,
        `matrix cell ${cellName} is absent`,
      );
    }
    const workload = recordValue(cell, "workload");
    const receipt = recordValue(cell, "receipt");
    const admission = recordValue(cell, "atomic_admission");
    const database = recordValue(cell, "database");
    const cpu = database === undefined ? undefined : recordValue(database, "cpu");
    const backends = database === undefined ? undefined : recordValue(database, "backends");
    const checkpoints = recordValue(cell, "checkpoints");
    const reconciliation = recordValue(cell, "reconciliation");
    const offered = workload === undefined ? undefined : numberValue(workload, "commands");
    const accepted = receipt === undefined ? undefined : numberValue(receipt, "accepted");
    const passed = cell.pass === true;
    records.push(
      baseRecord(source, {
        id: `matrix-${cellName}-admission`,
        alias: `Matrix ${cellName}`,
        run: `matrix-${cellName.toLowerCase()}`,
        gate: "admission",
        status: passed ? "PASS" : "FAIL",
        region: textValue(cell, "region") ?? "us-east4",
        topology: "streaming-pull",
        environment: "production",
        classification: "current",
        qualificationScope: "production",
        authority: "authoritative-stable-matrix-summary",
        checksum: indexed.artifact.sha256,
        facts: [
          ...numericFacts("workload", workload, [
            ["rate_per_second", "rate_per_second", "per_second"],
            ["duration_seconds", "duration_seconds", "seconds"],
            ["commands", "offered", "commands"],
          ]),
          ...numericFacts("outcome", receipt, [
            ["accepted", "accepted", "commands"],
            ["unknown", "unknown", "commands"],
            ["rejected", "rejected", "commands"],
          ]),
          ...(offered === undefined || accepted === undefined || offered === 0
            ? []
            : [fact("outcome", "acceptance_ratio", accepted / offered, "ratio")]),
          ...numericFacts("latency", receipt, [
            ["within_1_second_ratio", "receipt_within_one_second_ratio", "ratio"],
            ["p95_ms", "receipt_p95_ms", "milliseconds"],
            ["p99_ms", "receipt_p99_ms", "milliseconds"],
            ["max_ms", "receipt_max_ms", "milliseconds"],
          ]),
          ...numericFacts("postgres", admission, [
            ["mean_ms", "atomic_admission_mean_ms", "milliseconds"],
          ]),
          ...numericFacts("postgres", database, [["wal_bytes", "wal_bytes", "bytes"]]),
          ...numericFacts("postgres", cpu, [
            ["p95", "cpu_p95_ratio", "ratio"],
            ["max", "cpu_max_ratio", "ratio"],
          ]),
          ...numericFacts("postgres", backends, [
            ["p95", "backends_p95", "connections"],
            ["max", "backends_max", "connections"],
          ]),
          ...numericFacts("postgres", checkpoints, [
            ["checkpoint_starts", "checkpoint_starts", "count"],
          ]),
          ...numericFacts("outcome", reconciliation, [
            ["good_root_outcomes", "correct_root_outcomes", "commands"],
            ["succeeded_agent_runs", "succeeded_agent_runs", "agent_runs"],
          ]),
        ],
        requirements: [
          {
            issue: "87",
            requirement: "accepted work reconciles exactly",
            status: statusValue(reconciliation?.verdict),
            explanation:
              "Accepted-work reconciliation is independent from admission qualification.",
          },
          {
            issue: "87",
            requirement: "complete durable admission at target",
            status: passed ? "PASS" : "FAIL",
            explanation: "Every offered command must receive a known durable admission outcome.",
          },
        ],
        explanation: `Authoritative production-region matrix cell ${cellName}.`,
        limitations: passed
          ? []
          : ["Accepted-work correctness does not override failed admission."],
      }),
    );
    records.push(
      baseRecord(source, {
        id: `matrix-${cellName}-reconciliation`,
        alias: `Matrix ${cellName} reconciliation`,
        run: `matrix-${cellName.toLowerCase()}`,
        gate: "reconciliation",
        status: statusValue(reconciliation?.verdict),
        region: textValue(cell, "region") ?? "us-east4",
        topology: "streaming-pull",
        environment: "production",
        classification: "current",
        qualificationScope: "production",
        authority: "authoritative-stable-matrix-summary",
        checksum: indexed.artifact.sha256,
        facts: numericFacts("outcome", reconciliation, [
          ["good_root_outcomes", "correct_root_outcomes", "commands"],
          ["succeeded_agent_runs", "succeeded_agent_runs", "agent_runs"],
        ]),
        explanation: `Accepted-work reconciliation for production-region matrix cell ${cellName}.`,
        limitations: ["Reconciliation PASS does not override admission FAIL."],
      }),
    );
  }
  records.push(
    baseRecord(source, {
      id: "production-qualification",
      alias: "Overall production qualification",
      status: statusValue(indexed.value.full_us_east4_production_qualification),
      gate: "production_qualification",
      region: "us-east4",
      topology: "streaming-pull",
      environment: "production",
      classification: "current",
      qualificationScope: "production",
      authority: "authoritative-stable-matrix-summary",
      checksum: indexed.artifact.sha256,
      explanation:
        "The structured summary explicitly preserves full production qualification as MISSING.",
      limitations: [
        "Admission, saturation, recovery, multi-device load, ActionReceipt, and cost are not all closed.",
      ],
    }),
  );
  return {
    records,
    count: 4,
    integrityProvenance: `Artifact-index sha256 verified: ${indexed.artifact.sha256}`,
  };
};

const receiptSloAdapter = async (
  source: ManifestSource,
  context: CompilerContext,
  path: string,
): Promise<AdapterResult> => {
  const indexed = await indexedJson(context, path);
  const runs = indexed.value.runs;
  if (!Array.isArray(runs)) {
    throw new EvidenceCatalogError("INVALID_SOURCE", source.path, "receipt runs are absent");
  }
  const threshold = numberValue(indexed.value, "threshold_ms") ?? 1_000;
  const records = runs.map((raw, index) => {
    const run = requiredRecord(raw, `${source.path}.runs[${index}]`);
    const runName = textValue(run, "run") ?? `run-${index + 1}`;
    const ratio = numberValue(run, "within_threshold_ratio");
    const status: GateStatus = ratio === undefined ? "MISSING" : ratio >= 0.999 ? "PASS" : "FAIL";
    return baseRecord(source, {
      id: `${slug(runName)}-receipt`,
      alias: `${runName.replaceAll("-", " ")} receipt SLO`,
      run: runName,
      gate: "receipt_under_1s",
      status,
      environment: "non-production",
      classification: "historical",
      qualificationScope: "historical",
      authority: "artifact-index-checksummed-derivation",
      checksum: indexed.artifact.sha256,
      facts: [
        ...numericFacts("latency", run, [
          ["total", "sample_count", "commands"],
          ["over_threshold", "over_threshold_count", "commands"],
          ["within_threshold_ratio", "within_threshold_ratio", "ratio"],
        ]),
        fact("latency", "threshold_ms", threshold, "milliseconds"),
      ],
      explanation: "Exact threshold-count derivation from verified caller samples.",
      limitations: ["Non-production result cannot qualify production."],
    });
  });
  return {
    records,
    count: records.length,
    integrityProvenance: `Artifact-index sha256 verified: ${indexed.artifact.sha256}`,
  };
};

const safeSnapshotFacts = (
  raw: Schema.JsonObject,
  domain: CatalogFact["domain"],
  prefix = "",
): CatalogFact[] => {
  const facts: CatalogFact[] = [];
  for (const [key, value] of Object.entries(raw).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const name = slug(prefix.length === 0 ? key : `${prefix}-${key}`).replaceAll("-", "_");
    if (isJsonNumber(value) && Number.isFinite(value)) facts.push(fact(domain, name, value));
    else if (isJsonBoolean(value)) facts.push(fact(domain, name, value));
    else if (
      isJsonString(value) &&
      ["executionprofile", "modelbinding", "cancellationoutcome", "imagedigest"].includes(
        slug(key).replaceAll("-", ""),
      )
    ) {
      facts.push(fact(domain, name, value.slice(0, 160)));
    } else if (isJsonObject(value)) facts.push(...safeSnapshotFacts(value, domain, name));
  }
  return facts;
};

const developmentRuntimeAdapter = async (
  source: ManifestSource,
  context: CompilerContext,
  path: string,
): Promise<AdapterResult> => {
  const { value: raw } = await indexedJson(context, path);
  const facts = recordValue(raw, "facts");
  const snapshotFactStatus = (key: string) => statusValue(facts?.[key]);
  const positiveCountsStatus = (keys: ReadonlyArray<string>): GateStatus => {
    const values = keys.map((key) => (facts === undefined ? undefined : numberValue(facts, key)));
    return values.some((value) => value === undefined)
      ? "MISSING"
      : values.every((value) => value! > 0)
        ? "PASS"
        : "FAIL";
  };
  const main = baseRecord(source, {
    id: "development-runtime-current",
    alias: "Current development runtime",
    status: statusValue(raw.status),
    gate: "development_runtime",
    utc: { start: textValue(raw, "capturedAt") ?? null, end: textValue(raw, "capturedAt") ?? null },
    region: textValue(raw, "region") ?? "development",
    topology: textValue(raw, "topology") ?? "streaming-pull",
    environment: "development",
    classification: "current",
    qualificationScope: "development",
    authority: "sanitized-unsealed-development-snapshot",
    link: safePublicUrl(textValue(raw, "publicUrl") ?? source.publicUrl),
    facts: facts === undefined ? [] : safeSnapshotFacts(facts, "provider"),
    requirements: [
      {
        issue: "99",
        requirement: "production qualification",
        status: statusValue(raw.productionQualification),
        explanation: "Development smoke cannot qualify production.",
      },
    ],
    explanation: "Sanitized snapshot of the current bounded development smoke.",
    limitations: Array.isArray(raw.limitations)
      ? raw.limitations.filter(isJsonString)
      : ["Development scope only."],
  });
  const prior = Array.isArray(raw.priorAttempts) ? raw.priorAttempts : [];
  const gateStatuses: ReadonlyArray<readonly [string, GateStatus]> = [
    ["runtime_smoke", statusValue(raw.status)],
    [
      "provider_execution",
      positiveCountsStatus([
        "confirmedProviderRequestCount",
        "reportedUsageAttemptCount",
        "positiveReasoningUsageAttemptCount",
      ]),
    ],
    ["postgres_reconciliation", snapshotFactStatus("agentRunOutcome")],
    [
      "runtime_topology",
      positiveCountsStatus([
        "relayInstances",
        "relayPublishers",
        "workerInstances",
        "workerStreamsPerInstance",
        "workerSlotsPerInstance",
        "workerDatabasePoolPerInstance",
      ]),
    ],
    ["durable_receipt", snapshotFactStatus("durableReceipt")],
    ["idempotent_replay", snapshotFactStatus("idempotentDuplicateAdmission")],
    ["agent_run_outcome", snapshotFactStatus("agentRunOutcome")],
    ["cursor_resume", positiveCountsStatus(["independentCursorCheckpoints"])],
    [
      "cancellation_request",
      facts?.cancellationOutcome === "cancellationRequested"
        ? "PASS"
        : facts?.cancellationOutcome === undefined
          ? "MISSING"
          : "FAIL",
    ],
    ["cancellation_completion", "MISSING"],
    ["current_image_digest", isJsonString(facts?.imageDigest) ? "PASS" : "MISSING"],
  ];
  const records: CatalogRecord[] = [
    main,
    ...gateStatuses.map(([gate, gateStatus]) =>
      baseRecord(source, {
        id: `development-runtime-${gate.replaceAll("_", "-")}`,
        alias: `Development ${gate.replaceAll("_", " ")}`,
        status: gateStatus,
        gate,
        utc: {
          start: textValue(raw, "capturedAt") ?? null,
          end: textValue(raw, "capturedAt") ?? null,
        },
        region: textValue(raw, "region") ?? "development",
        topology: textValue(raw, "topology") ?? "streaming-pull",
        environment: "development",
        classification: "current",
        qualificationScope: "development",
        authority: "sanitized-unsealed-development-snapshot",
        explanation: `Bounded development gate: ${gate.replaceAll("_", " ")}.`,
        limitations: ["Development scope only."],
      }),
    ),
    ...prior.map((value, index) => {
      const attempt = requiredRecord(value, `${source.path}.priorAttempts[${index}]`);
      const alias = textValue(attempt, "alias") ?? `Prior runtime attempt ${index + 1}`;
      return baseRecord(source, {
        id: `development-runtime-prior-${index + 1}-${slug(alias)}`,
        alias,
        status: statusValue(attempt.status),
        gate: "development_runtime_attempt",
        environment: "development",
        classification: "current",
        qualificationScope: "development",
        authority: "sanitized-unsealed-development-snapshot",
        facts: safeSnapshotFacts(attempt, "provider"),
        explanation: "Bounded prior development attempt retained including its failure state.",
        limitations: [textValue(attempt, "limitation") ?? "Development scope only."],
      });
    }),
  ];
  records.push(
    baseRecord(source, {
      id: "development-runtime-production-qualification",
      alias: "Development runtime production qualification",
      status: "MISSING",
      gate: "production_qualification",
      utc: {
        start: textValue(raw, "capturedAt") ?? null,
        end: textValue(raw, "capturedAt") ?? null,
      },
      region: textValue(raw, "region") ?? "us-east4",
      topology: textValue(raw, "topology") ?? "streaming-pull",
      environment: "production",
      classification: "current",
      qualificationScope: "production",
      authority: "sanitized-unsealed-development-snapshot",
      explanation:
        "The development runtime snapshot explicitly leaves production qualification MISSING.",
      limitations: ["Development evidence cannot establish production qualification."],
    }),
  );
  return {
    records,
    count: records.length,
    integrityProvenance: "Tracked sanitized snapshot, explicitly unsealed and development-only.",
  };
};

const developmentSseAdapter = async (
  source: ManifestSource,
  context: CompilerContext,
  path: string,
): Promise<AdapterResult> => {
  const { value: raw } = await indexedJson(context, path);
  if (!Array.isArray(raw.attempts)) {
    throw new EvidenceCatalogError("INVALID_SOURCE", source.path, "attempt list is absent");
  }
  const records = raw.attempts.map((value, index) => {
    const attempt = requiredRecord(value, `${source.path}.attempts[${index}]`);
    const attemptId = textValue(attempt, "id") ?? `attempt-${index + 1}`;
    const gates = recordValue(attempt, "gates") ?? {};
    const requirements = Object.entries(gates).map(([requirement, verdict]) => ({
      issue: "100",
      requirement,
      status: statusValue(verdict),
      explanation: "Bounded development SSE attempt gate.",
    }));
    return baseRecord(source, {
      id: slug(attemptId),
      alias: `Development SSE attempt ${index + 1}`,
      run: slug(attemptId),
      category: "development-sse",
      status: statusValue(attempt.status),
      gate: "bounded_sse",
      utc: {
        start: textValue(attempt, "startedAt") ?? null,
        end: textValue(attempt, "finishedAt") ?? null,
      },
      region: textValue(raw, "region") ?? "development",
      topology: "cursor-sse",
      environment: "development",
      classification: "current",
      qualificationScope: "development",
      authority: "sanitized-unsealed-development-snapshot",
      facts: [
        ...numericFacts("workload", attempt, [
          ["deviceCount", "device_count", "devices"],
          ["loadCommandCount", "load_command_count", "commands"],
          ["commandIntervalMs", "command_interval_ms", "milliseconds"],
        ]),
        ...safeSnapshotFacts(recordValue(attempt, "facts") ?? {}, "sse"),
      ],
      requirements,
      explanation: "Sanitized bounded development SSE attempt, including failures.",
      limitations: Array.isArray(attempt.limitations)
        ? attempt.limitations.filter(isJsonString)
        : ["Development scope only."],
    });
  });
  for (const [index, value] of raw.attempts.entries()) {
    const attempt = requiredRecord(value, `${source.path}.attempts[${index}]`);
    const attemptId = textValue(attempt, "id") ?? `attempt-${index + 1}`;
    const gates = recordValue(attempt, "gates") ?? {};
    for (const [gate, verdict] of Object.entries(gates)) {
      records.push(
        baseRecord(source, {
          id: `${slug(attemptId)}-${slug(gate)}`,
          alias: `Development SSE attempt ${index + 1}: ${gate.replaceAll(/([A-Z])/gu, " $1").toLowerCase()}`,
          run: slug(attemptId),
          category: "development-sse",
          status: statusValue(verdict),
          gate: slug(gate).replaceAll("-", "_"),
          utc: {
            start: textValue(attempt, "startedAt") ?? null,
            end: textValue(attempt, "finishedAt") ?? null,
          },
          region: textValue(raw, "region") ?? "development",
          topology: "cursor-sse",
          environment: "development",
          classification: "current",
          qualificationScope: "development",
          authority: "sanitized-unsealed-development-snapshot",
          explanation: "Bounded development SSE gate from the sanitized attempt snapshot.",
          limitations: ["Development scope only."],
        }),
      );
    }
  }
  records.push(
    baseRecord(source, {
      id: "development-sse-production-qualification",
      alias: "Development SSE production qualification",
      status: statusValue(raw.productionQualification),
      gate: "production_qualification",
      category: "development-sse",
      region: textValue(raw, "region") ?? "development",
      topology: "cursor-sse",
      environment: "development",
      classification: "current",
      qualificationScope: "development",
      authority: "sanitized-unsealed-development-snapshot",
      explanation: "Development SSE evidence explicitly cannot qualify production.",
      limitations: Array.isArray(raw.outstandingGates)
        ? raw.outstandingGates.filter(isJsonString)
        : [],
    }),
  );
  const outstanding = Array.isArray(raw.outstandingGates)
    ? raw.outstandingGates.filter(isJsonString)
    : [];
  for (const gate of new Set(["target_load_streaming", ...outstanding])) {
    records.push(
      baseRecord(source, {
        id: `production-sse-${slug(gate)}`,
        alias: `Production ${gate.replaceAll("_", " ")}`,
        category: "development-sse",
        status: "MISSING",
        gate,
        region: textValue(raw, "region") ?? "us-east4",
        topology: "cursor-sse",
        environment: "production",
        classification: "current",
        qualificationScope: "production",
        authority: "sanitized-unsealed-development-snapshot",
        explanation: `Outstanding production SSE gate: ${gate.replaceAll("_", " ")}.`,
        limitations: ["No sealed production proof exists."],
      }),
    );
  }
  return {
    records,
    count: raw.attempts.length,
    integrityProvenance: "Tracked sanitized snapshot, explicitly unsealed and development-only.",
  };
};

const developmentCloudAdapter = async (
  source: ManifestSource,
  context: CompilerContext,
  path: string,
): Promise<AdapterResult> => {
  const { value: raw } = await indexedJson(context, path);
  const services = Array.isArray(raw.services) ? raw.services : [];
  const records = [
    baseRecord(source, {
      id: "development-cloud-metadata",
      alias: "Development cloud metadata",
      category: "cloud-monitoring-metadata",
      status: statusValue(raw.status),
      gate: "runtime_topology",
      utc: {
        start: textValue(raw, "capturedAt") ?? null,
        end: textValue(raw, "capturedAt") ?? null,
      },
      region: textValue(raw, "region") ?? "development",
      topology: "streaming-pull",
      environment: "development",
      classification: "current",
      qualificationScope: "development",
      authority: "sanitized-read-only-cloud-metadata",
      facts: [
        ...safeSnapshotFacts(recordValue(raw, "database") ?? {}, "postgres"),
        ...safeSnapshotFacts(recordValue(raw, "subscription") ?? {}, "provider"),
        ...services.flatMap((value) =>
          isJsonObject(value)
            ? safeSnapshotFacts(value, "fleet", textValue(value, "alias") ?? "service")
            : [],
        ),
      ],
      explanation:
        "Read-only development metadata. Provider payloads and resource identifiers are excluded.",
      limitations: Array.isArray(raw.limitations)
        ? raw.limitations.filter(isJsonString)
        : ["Development metadata does not certify production."],
    }),
    baseRecord(source, {
      id: "development-cloud-resource-measurements",
      alias: "Development cloud resource measurements",
      category: "cloud-monitoring-metadata",
      status: statusValue(recordValue(raw, "monitoring")?.resourceMeasurements),
      gate: "resource_measurements",
      utc: {
        start: textValue(raw, "capturedAt") ?? null,
        end: textValue(raw, "capturedAt") ?? null,
      },
      region: textValue(raw, "region") ?? "development",
      topology: "streaming-pull",
      environment: "development",
      classification: "current",
      qualificationScope: "development",
      authority: "sanitized-read-only-cloud-metadata",
      explanation:
        "Resource measurements remain MISSING when requested monitoring windows contain no points.",
      limitations: ["Missing measurements are not zero."],
    }),
  ];
  return {
    records,
    count: 1,
    integrityProvenance:
      "Tracked sanitized read-only snapshot, explicitly unsealed and development-only.",
  };
};

const githubContextAdapter = async (
  source: ManifestSource,
  context: CompilerContext,
  path: string,
): Promise<AdapterResult> => {
  const { value: raw } = await indexedJson(context, path);
  if (!Array.isArray(raw.issues)) {
    throw new EvidenceCatalogError("INVALID_SOURCE", source.path, "issues are absent");
  }
  const records = raw.issues.map((value, index) => {
    const issue = requiredRecord(value, `${source.path}.issues[${index}]`);
    const number = numberValue(issue, "number");
    if (number === undefined || !Number.isInteger(number)) {
      throw new EvidenceCatalogError("INVALID_SOURCE", source.path, "issue number is invalid");
    }
    return baseRecord(source, {
      id: `issue-${number}`,
      alias: `Issue #${number}: ${textValue(issue, "title") ?? "context"}`,
      issue: String(number),
      status: statusValue(issue.status),
      gate: "issue_disposition",
      utc: {
        start: textValue(issue, "updatedAt") ?? null,
        end: textValue(issue, "updatedAt") ?? null,
      },
      environment: "external-context",
      classification: "contextual",
      qualificationScope: "contextual",
      authority: "external-unsealed-github-snapshot",
      link: safePublicUrl(textValue(issue, "url") ?? source.publicUrl),
      requirements:
        number === 67
          ? [
              {
                issue: "67",
                requirement: "ToolCall foundation at current-foundation-only scope",
                status: "PASS" as const,
                explanation:
                  "The current foundation exists, but integration qualification remains separate.",
              },
              {
                issue: "67",
                requirement: "ToolCall end-to-end integration",
                status: "MISSING" as const,
                explanation: "No current end-to-end qualification is recorded.",
              },
              {
                issue: "67",
                requirement: "ToolCall recovery qualification",
                status: "MISSING" as const,
                explanation: "Recovery and retry proof remains outstanding.",
              },
            ]
          : number === 68
            ? [
                {
                  issue: "68",
                  requirement: "Action foundation at current-local-foundation-only scope",
                  status: "PASS" as const,
                  explanation:
                    "Immutable policy, approval, and reconciliation records; pinned Mailpit lost-ack reconciliation; a sanitized receipt fold; and cancellation guards are implemented.",
                },
                {
                  issue: "68",
                  requirement: "real external provider qualification",
                  status: "MISSING" as const,
                  explanation: "The foundation is not qualified against a real external provider.",
                },
                {
                  issue: "68",
                  requirement: "authenticated approval API and UI",
                  status: "MISSING" as const,
                  explanation: "Authenticated operator approval surfaces remain outstanding.",
                },
                {
                  issue: "68",
                  requirement: "model-selected OpenRouter Action routing",
                  status: "MISSING" as const,
                  explanation: "Model-selected Action routing remains outstanding.",
                },
                {
                  issue: "68",
                  requirement: "full AgentRun wait and wake integration",
                  status: "MISSING" as const,
                  explanation:
                    "The complete durable AgentRun wait and wake path remains outstanding.",
                },
                {
                  issue: "68",
                  requirement: "authorized Action content references",
                  status: "MISSING" as const,
                  explanation:
                    "Authorized content references remain outstanding and no content is published here.",
                },
                {
                  issue: "68",
                  requirement: "Action load qualification",
                  status: "MISSING" as const,
                  explanation: "No current load qualification exists for the Action path.",
                },
                {
                  issue: "68",
                  requirement: "interactive browser Action journey",
                  status: "MISSING" as const,
                  explanation: "No authenticated interactive browser Action journey is qualified.",
                },
                {
                  issue: "68",
                  requirement: "production ActionReceipt implementation and qualification",
                  status: "MISSING" as const,
                  explanation: "Issue #68 remains open and production qualification is absent.",
                },
              ]
            : [],
      explanation: textValue(issue, "disposition") ?? "External issue context.",
      limitations: ["GitHub context is unsealed and cannot establish evidence qualification."],
    });
  });
  return {
    records,
    count: records.length,
    integrityProvenance:
      "Tracked deterministic external context snapshot, never treated as sealed evidence.",
  };
};

const verifyChecksumEntry = async (repoRoot: string, resultPath: string) => {
  const resultName = basename(resultPath);
  let expected: string | undefined;
  let manifestPath = resolve(dirname(resultPath), "SHA256SUMS");
  for (const name of ["SHA256SUMS", "REPORT_SHA256SUMS"]) {
    const candidatePath = resolve(dirname(resultPath), name);
    const manifest = await readRegularFile(repoRoot, candidatePath)
      .then((bytes) => bytes.toString("utf8"))
      .catch(() => undefined);
    if (manifest === undefined) continue;
    const entry = manifest
      .split(/\r?\n/gu)
      .map((line) => /^([a-f0-9]{64})\s+[ *]?(?:\.\/)?(.+)$/u.exec(line))
      .find((match) => match?.[2] === resultName);
    if (entry?.[1] !== undefined) {
      expected = entry[1];
      manifestPath = candidatePath;
      break;
    }
  }
  if (expected === undefined) {
    throw new EvidenceCatalogError(
      "INVALID_SOURCE",
      relative(repoRoot, manifestPath),
      "result entry is absent",
    );
  }
  const bytes = await readRegularFile(repoRoot, resultPath);
  if (sha256(bytes) !== expected) {
    throw new EvidenceCatalogError(
      "CHECKSUM_MISMATCH",
      relative(repoRoot, resultPath),
      "prototype result differs",
    );
  }
  return {
    digest: expected,
    raw: requiredRecord(decodeJsonBytes(bytes, relative(repoRoot, resultPath)), resultPath),
  };
};

const prototypeResultAdapter = async (
  source: ManifestSource,
  context: CompilerContext,
  path: string,
): Promise<AdapterResult> => {
  const verified = await verifyChecksumEntry(context.repoRoot, path);
  const raw = verified.raw;
  const facts = [
    ...numericFacts("workload", raw, [
      ["rate_per_second", "rate_per_second", "per_second"],
      ["duration_seconds", "duration_seconds", "seconds"],
      ["offered", "offered", "commands"],
    ]),
    ...numericFacts("outcome", raw, [
      ["accepted", "accepted", "commands"],
      ["completed", "completed", "commands"],
      ["rejected_or_failed", "rejected_or_failed", "commands"],
      ["drain_seconds", "drain_seconds", "seconds"],
      ["device_count", "device_count", "devices"],
      ["resume_duplicate_count", "resume_duplicate_count", "events"],
    ]),
    ...numericFacts("latency", recordValue(raw, "admission_latency"), [
      ["p95_ms", "admission_p95_ms", "milliseconds"],
      ["p99_ms", "admission_p99_ms", "milliseconds"],
    ]),
  ];
  if (source.id === "historical-four-device") {
    for (const [key, value] of Object.entries(raw)) {
      if (isJsonBoolean(value)) facts.push(fact("sse", slug(key).replaceAll("-", "_"), value));
    }
  }
  if (source.id === "historical-mailpit-action") {
    facts.push(fact("action", "mailpit_test_sink_control", true));
    facts.push(fact("toolcall", "bounded_send_email_toolcalls", 20, "toolcalls"));
  }
  const startMicros = numberValue(raw, "started_at_unix_microseconds");
  const endMicros = numberValue(raw, "ended_at_unix_microseconds");
  const toUtc = (micros: number | undefined) =>
    micros === undefined ? null : new Date(Math.floor(micros / 1_000)).toISOString();
  const record = baseRecord(source, {
    id: source.id,
    alias: source.id.replaceAll("-", " "),
    status: source.status ?? "MISSING",
    category: source.id === "historical-mailpit-action" ? "external-action" : source.category,
    gate:
      source.id === "historical-breaking-464"
        ? "breaking_point"
        : source.id === "historical-process-loss"
          ? "process_loss_under_load"
          : source.id === "historical-four-device"
            ? "four_device_replay"
            : source.id === "historical-mailpit-action"
              ? "mailpit_retry"
              : "historical_context",
    utc: { start: toUtc(startMicros), end: toUtc(endMicros) },
    region: "northamerica-northeast2",
    topology: source.id === "historical-mailpit-action" ? "temporal-prototype" : "direct-dispatch",
    environment: "prototype",
    classification: "historical",
    qualificationScope: "historical",
    authority: "checksum-manifest-entry-verified",
    checksum: verified.digest,
    facts,
    requirements:
      source.id === "historical-mailpit-action"
        ? [
            {
              issue: "68",
              requirement: "Mailpit 20 of 20 historical retry control",
              status: "PASS",
              explanation: "Historical test-sink proof only, not production ActionReceipt proof.",
            },
          ]
        : [],
    explanation: source.structure,
    limitations: source.exclusionReason === null ? [] : [source.exclusionReason],
  });
  return {
    records: [record],
    count: 1,
    integrityProvenance: `SHA256SUMS result entry verified: ${verified.digest}`,
  };
};

const physicalDirectoryFileCount = async (repoRoot: string, root: string): Promise<number> => {
  let count = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new EvidenceCatalogError(
        "INVALID_SOURCE",
        relative(repoRoot, resolve(root, entry.name)),
        "inventory symlink is forbidden",
      );
    }
    if (entry.isDirectory()) {
      count += await physicalDirectoryFileCount(repoRoot, resolve(root, entry.name));
    } else if (entry.isFile()) count += 1;
  }
  return count;
};

const directoryFileCount = async (repoRoot: string, root: string): Promise<number> => {
  const hasGitMetadata = await access(resolve(repoRoot, ".git")).then(
    () => true,
    () => false,
  );
  if (!hasGitMetadata) return physicalDirectoryFileCount(repoRoot, root);

  const trackedEntries = execFileSync(
    "git",
    ["-C", repoRoot, "ls-files", "--stage", "-z", "--", relative(repoRoot, root)],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((entry) => entry.length > 0);
  for (const entry of trackedEntries) {
    if (entry.startsWith("120000 ")) {
      throw new EvidenceCatalogError(
        "INVALID_SOURCE",
        entry.slice(entry.indexOf("\t") + 1),
        "inventory symlink is forbidden",
      );
    }
  }
  return trackedEntries.length;
};

const adaptSource = async (
  source: ManifestSource,
  context: CompilerContext,
): Promise<AdapterResult> => {
  const path = sourceAbsolutePath(context.repoRoot, source);
  const present = await access(path).then(
    () => true,
    () => false,
  );
  if (!present) {
    if (source.required) {
      throw new EvidenceCatalogError("INVALID_SOURCE", source.path, "required source is missing");
    }
    return { records: [], count: 0, integrityProvenance: "Optional source is absent." };
  }
  switch (source.adapter) {
    case "packet-index":
      return packetIndexAdapter(source, context);
    case "evidence-markdown":
      return evidenceMarkdownAdapter(source, context, path);
    case "packet-runs":
      return packetRunsAdapter(source, context, path);
    case "matrix-summary":
      return matrixSummaryAdapter(source, context, path);
    case "receipt-slo":
      return receiptSloAdapter(source, context, path);
    case "development-runtime":
      return developmentRuntimeAdapter(source, context, path);
    case "development-sse":
      return developmentSseAdapter(source, context, path);
    case "development-cloud":
      return developmentCloudAdapter(source, context, path);
    case "github-context":
      return githubContextAdapter(source, context, path);
    case "prototype-result":
      return prototypeResultAdapter(source, context, path);
    case "directory-inventory":
      return {
        records: [],
        count: await directoryFileCount(context.repoRoot, path),
        integrityProvenance:
          "Recursive regular-file inventory; excluded files are not qualification inputs.",
      };
    case "file-inventory":
      await readRegularFile(context.repoRoot, path);
      return {
        records: [],
        count: 1,
        integrityProvenance: source.exclusionReason ?? "Explicit file inventory exclusion.",
      };
  }
};

const metricLabel = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"')}"`;

const metricLabels = (labels: Readonly<Record<string, string>>) =>
  `{${Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${metricLabel(value)}`)
    .join(",")}}`;

const metricStatusValue = (status: GateStatus) =>
  status === "PASS" ? 1 : status === "FAIL" ? 0 : -1;

const humanMetricLabel = (value: string) =>
  value
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll(/[._-]+/gu, " ")
    .trim();

const displayFact = (record: CatalogRecord, names: ReadonlyArray<string>) => {
  const value = record.facts.find(
    (item) => names.includes(item.name) && item.status !== "MISSING" && item.value !== null,
  )?.value;
  if (value === undefined) return "MISSING";
  if (isJsonBoolean(value)) return value ? "PASS" : "FAIL";
  return String(value).slice(0, 160);
};

const renderMetrics = (
  catalog: ReadonlyArray<CatalogRecord>,
  coverage: ReadonlyArray<CoverageRecord>,
) => {
  const lines = [
    "# OpenPoke catalog metrics are derived presentation data. Structured records remain authoritative.",
  ];
  for (const record of catalog) {
    const metricDisposition =
      record.disposition === "import"
        ? "imported"
        : record.disposition === "represent"
          ? "represented"
          : record.disposition === "link"
            ? "linked"
            : "excluded";
    const common = {
      alias: record.alias.slice(0, 120),
      category: record.category,
      classification: record.classification,
      acceptance_ratio: displayFact(record, ["acceptance_ratio"]),
      accepted: displayFact(record, ["accepted", "acceptedcommandcount"]),
      budget_release: displayFact(record, ["capacity_reservations_released"]),
      claim_p99_ms: displayFact(record, ["delivery_to_claim_p99_ms"]),
      commands: displayFact(record, ["load_command_count"]),
      completed: displayFact(record, ["completed_agent_runs", "completed"]),
      convergence: displayFact(record, ["reconciledagentruns", "identical_replay"]),
      devices: displayFact(record, ["device_count", "distinctdevicecursors"]),
      drain: displayFact(record, ["commandterminaldrainms", "drain_seconds"]),
      duplicates: displayFact(record, [
        "streamduplicates",
        "resume_duplicate_count",
        "duplicate_terminal_commits",
      ]),
      environment: record.environment,
      execution_profile: displayFact(record, ["executionprofile"]),
      explanation: record.explanation.slice(0, 200),
      gaps: displayFact(record, ["streamgaps", "zero_gaps"]),
      image_digest: displayFact(record, ["imagedigest"]),
      issue: record.issue ?? "none",
      limitation: record.limitations[0]?.slice(0, 160) ?? "none",
      model_binding: displayFact(record, ["modelbinding"]),
      nonterminal_runs: displayFact(record, ["nonterminal_agent_runs"]),
      offered: displayFact(record, ["offered"]),
      ordering: displayFact(record, ["orderingviolations", "correct_order"]),
      public_url: record.link ?? "MISSING",
      qualification_scope: record.qualificationScope,
      receipt_p95_ms: displayFact(record, ["receipt_p95_ms"]),
      receipt_p99_ms: displayFact(record, ["receipt_p99_ms"]),
      record: record.id,
      region: record.region,
      resumes: displayFact(record, ["resume_after_cursor", "replaylatencyms"]),
      run: record.run ?? "none",
      scope: record.qualificationScope,
      terminal: displayFact(record, ["reconciledagentruns"]),
      terminal_unique: displayFact(record, ["terminal_uniqueness"]),
      topology: record.topology,
      topology_alias: humanMetricLabel(record.topology).slice(0, 120),
      unfinished_attempts: displayFact(record, ["unfinished_agent_run_attempts"]),
      unknown_outcomes: displayFact(record, ["unknown", "unknown_caller_outcomes"]),
      utc: record.utc.end ?? record.utc.start ?? "unspecified",
      workers: displayFact(record, ["worker_instances"]),
      stranded_work: displayFact(record, ["stranded_accepted_runs"]),
    };
    lines.push(
      `openpoke_catalog_record_info${metricLabels({
        ...common,
        authority: record.authority,
        disposition: metricDisposition,
        source: record.sourceId,
        status: record.status,
      })} 1`,
      `openpoke_catalog_status${metricLabels({
        ...common,
        gate: record.gate,
        status: record.status,
      })} ${metricStatusValue(record.status)}`,
    );
    for (const item of record.facts) {
      if (!isJsonNumber(item.value) || item.status === "MISSING") continue;
      lines.push(
        `openpoke_catalog_fact${metricLabels({
          alias: common.alias,
          category: record.category,
          classification: record.classification,
          environment: record.environment,
          fact: `${item.domain}.${item.name}`,
          fact_alias: humanMetricLabel(`${item.domain} ${item.name}`).slice(0, 120),
          issue: record.issue ?? "none",
          qualification_scope: record.qualificationScope,
          record: record.id,
          region: record.region,
          run: record.run ?? "none",
          status: item.status,
          topology: record.topology,
          unit: item.unit === null ? "none" : humanMetricLabel(item.unit),
        })} ${item.value}`,
      );
    }
    for (const requirement of record.requirements) {
      lines.push(
        `openpoke_catalog_requirement_status${metricLabels({
          alias: common.alias,
          environment: record.environment,
          explanation: requirement.explanation.slice(0, 160),
          issue: requirement.issue,
          qualification_scope: record.qualificationScope,
          record: record.id,
          requirement: requirement.requirement,
          requirement_alias: humanMetricLabel(requirement.requirement).slice(0, 120),
          status: requirement.status,
        })} ${metricStatusValue(requirement.status)}`,
      );
    }
    if (record.link !== null) {
      lines.push(
        `openpoke_catalog_link_info${metricLabels({
          alias: common.alias,
          link_kind: "public",
          public_url: record.link,
          record: record.id,
        })} 1`,
      );
    }
  }
  for (const source of coverage) {
    const metricDisposition =
      source.disposition === "import"
        ? "imported"
        : source.disposition === "represent"
          ? "represented"
          : source.disposition === "link"
            ? "linked"
            : "excluded";
    lines.push(
      `openpoke_catalog_source_info${metricLabels({
        category: source.category,
        disposition: metricDisposition,
        exclusion_reason: source.exclusionReason ?? "none",
        integrity: source.integrityProvenance,
        integrity_provenance: source.integrityProvenance,
        issue_or_requirement: source.issueOrRequirement.join("; "),
        public_url: source.publicUrl ?? "none",
        repo_path: source.path,
        scope: source.scope,
        seal: source.seal,
        source: source.sourceId,
        source_alias: source.sourceId.replaceAll("-", " "),
        structure: source.structure,
      })} ${source.count}`,
    );
  }
  lines.push("");
  return lines.join("\n");
};

const utcRange = (records: ReadonlyArray<CatalogRecord>) => {
  const starts = records.flatMap((record) => (record.utc.start === null ? [] : [record.utc.start]));
  const ends = records.flatMap((record) => (record.utc.end === null ? [] : [record.utc.end]));
  const validStarts = starts.filter((value) => Number.isFinite(Date.parse(value))).sort();
  const validEnds = ends.filter((value) => Number.isFinite(Date.parse(value))).sort();
  return validStarts.length === 0 || validEnds.length === 0
    ? null
    : { from: validStarts[0]!, to: validEnds[validEnds.length - 1]! };
};

const assertSafeOutput = (value: string) => {
  const unsafe = [
    /\/home\//iu,
    /file:\/\//iu,
    /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]/iu,
    /bearer\s+[a-z0-9._-]{12,}/iu,
    /\bsk-[a-z0-9_-]{12,}\b/iu,
  ];
  if (unsafe.some((pattern) => pattern.test(value))) {
    throw new EvidenceCatalogError(
      "UNSAFE_OUTPUT",
      "catalog",
      "output contains a private path or likely secret",
    );
  }
};

export const compileEvidenceCatalog = async (
  manifestPath: string,
  options: { readonly repoRoot?: string } = {},
): Promise<EvidenceCatalogResult> => {
  const manifest = await validateManifest(resolve(manifestPath));
  const repoRoot = await realpath(options.repoRoot ?? resolve(dirname(manifestPath), ".."));
  const packetSource = manifest.sources.find((source) => source.adapter === "packet-index");
  if (packetSource === undefined) {
    throw new EvidenceCatalogError(
      "INVALID_MANIFEST",
      manifestPath,
      "packet-index source is required",
    );
  }
  const verifiedIndex = await verifyArtifactIndex(
    repoRoot,
    sourceAbsolutePath(repoRoot, packetSource),
  );
  const context: CompilerContext = {
    repoRoot,
    packetDirectory: verifiedIndex.packetDirectory,
    artifacts: verifiedIndex.artifacts,
    verifiedArtifactBytes: verifiedIndex.verifiedArtifactBytes,
  };
  const catalog: CatalogRecord[] = [];
  const coverage: CoverageRecord[] = [];
  for (const source of manifest.sources) {
    const result = await adaptSource(source, context);
    catalog.push(...result.records);
    coverage.push({
      sourceId: source.id,
      category: source.category,
      path: source.path,
      publicUrl: source.publicUrl,
      count: result.count,
      structure: source.structure,
      seal: source.seal,
      scope: source.scope,
      disposition: source.disposition,
      exclusionReason: source.exclusionReason,
      issueOrRequirement: source.issueOrRequirement,
      integrityProvenance: result.integrityProvenance,
    });
  }
  const ids = new Set<string>();
  for (const record of catalog) {
    if (ids.has(record.id)) {
      throw new EvidenceCatalogError(
        "DUPLICATE_ID",
        record.id,
        "normalized record id is duplicated",
      );
    }
    ids.add(record.id);
    if (
      record.qualificationScope === "production" &&
      (record.environment !== "production" || record.classification !== "current")
    ) {
      throw new EvidenceCatalogError(
        "INVALID_SOURCE",
        record.id,
        "non-production record was promoted",
      );
    }
    if (record.authority.includes("github") && record.qualificationScope !== "contextual") {
      throw new EvidenceCatalogError(
        "INVALID_SOURCE",
        record.id,
        "GitHub context cannot become sealed qualification",
      );
    }
  }
  catalog.sort((left, right) => left.id.localeCompare(right.id));
  coverage.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const metrics = renderMetrics(catalog, coverage);
  const presentationTimestamp = Math.max(
    0,
    ...catalog.map((record) =>
      record.utc.end === null || !Number.isFinite(Date.parse(record.utc.end))
        ? 0
        : Math.floor(Date.parse(record.utc.end) / 1_000),
    ),
  );
  const openMetrics = `${metrics
    .trimEnd()
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => (presentationTimestamp === 0 ? line : `${line} ${presentationTimestamp}`))
    .join("\n")}\n# EOF\n`;
  const statusCounts = { PASS: 0, FAIL: 0, MISSING: 0 } satisfies Record<GateStatus, number>;
  for (const record of catalog) statusCounts[record.status] += 1;
  const importReport = {
    schemaVersion: 1 as const,
    sourceCount: coverage.length,
    recordCount: catalog.length,
    statusCounts,
    utcRange: utcRange(catalog),
  };
  for (const output of [
    JSON.stringify(catalog),
    JSON.stringify(coverage),
    JSON.stringify(importReport),
    metrics,
    openMetrics,
  ]) {
    assertSafeOutput(output);
  }
  return { catalog, coverage, metrics, openMetrics, importReport };
};

const publishFresh = async (outputs: ReadonlyArray<readonly [string, string]>) => {
  const canonical = outputs.map(([path, contents]) => [resolve(path), contents] as const);
  if (new Set(canonical.map(([path]) => path)).size !== canonical.length) {
    throw new EvidenceCatalogError("INVALID_MANIFEST", "outputs", "output paths must be distinct");
  }
  for (const [path] of canonical) {
    await access(path).then(
      () => {
        throw new EvidenceCatalogError("INVALID_MANIFEST", path, "output path must be fresh");
      },
      () => undefined,
    );
  }
  const prepared: Array<{ target: string; temporary: string }> = [];
  const published: string[] = [];
  try {
    for (const [target, contents] of canonical) {
      const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
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
    for (const item of prepared) {
      await rename(item.temporary, item.target);
      published.push(item.target);
    }
  } catch (cause) {
    await Promise.allSettled([
      ...prepared.map((item) => unlink(item.temporary)),
      ...published.map((path) => unlink(path)),
    ]);
    throw cause;
  }
};

const runCli = async () => {
  const arguments_ = process.argv.slice(2);
  const valueFor = (flag: string) => {
    const index = arguments_.indexOf(flag);
    return index < 0 ? undefined : arguments_[index + 1];
  };
  const manifest = valueFor("--manifest");
  const metrics = valueFor("--metrics");
  const openMetrics = valueFor("--openmetrics");
  const catalog = valueFor("--catalog");
  const coverage = valueFor("--coverage");
  const importReport = valueFor("--import-report");
  if (
    manifest === undefined ||
    metrics === undefined ||
    openMetrics === undefined ||
    catalog === undefined ||
    coverage === undefined ||
    importReport === undefined
  ) {
    throw new EvidenceCatalogError(
      "INVALID_MANIFEST",
      "cli",
      "usage: evidence-catalog.ts --manifest MANIFEST --metrics FILE --openmetrics FILE --catalog FILE --coverage FILE --import-report FILE",
    );
  }
  const result = await compileEvidenceCatalog(manifest);
  await publishFresh([
    [metrics, result.metrics],
    [openMetrics, result.openMetrics],
    [catalog, `${JSON.stringify(result.catalog, undefined, 2)}\n`],
    [coverage, `${JSON.stringify(result.coverage, undefined, 2)}\n`],
    [importReport, `${JSON.stringify(result.importReport, undefined, 2)}\n`],
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
