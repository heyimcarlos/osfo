import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(root, "grafana/dashboards");
const execFileAsync = promisify(execFile);
const datasource = { type: "prometheus", uid: "openpoke-prometheus" };

const dashboardDefinitions = [
  ["openpoke-executive-summary", "Executive Summary"],
  ["openpoke-development-runtime", "Development Runtime"],
  ["openpoke-load-admission", "Load and Admission"],
  ["openpoke-postgres-capacity", "PostgreSQL and Capacity"],
  ["openpoke-durability-recovery", "Durability and Recovery"],
  ["openpoke-multi-device-streaming", "Multi-device and Streaming"],
  ["openpoke-toolcalls-actions", "ToolCalls and External Actions"],
  ["openpoke-evidence-catalog", "Evidence Catalog and Provenance"],
];

const dashboardLinks = dashboardDefinitions.map(([uid, title]) => ({
  title,
  type: "link",
  url: `/d/${uid}`,
  includeVars: true,
  keepTime: true,
}));

const target = (expr, refId = "A") => ({
  datasource,
  editorMode: "code",
  expr,
  instant: true,
  legendFormat: "",
  range: false,
  refId,
});

const grid = (x, y, w, h) => ({ x, y, w, h });

const numericStatusMappings = [
  {
    type: "value",
    options: {
      "-1": { color: "gray", index: 2, text: "MISSING" },
      0: { color: "red", index: 1, text: "FAIL" },
      1: { color: "green", index: 0, text: "PASS" },
    },
  },
];

const stringStatusMappings = [
  {
    type: "value",
    options: {
      FAIL: { color: "red", index: 1, text: "FAIL" },
      MISSING: { color: "gray", index: 2, text: "MISSING" },
      PASS: { color: "green", index: 0, text: "PASS" },
    },
  },
];

const classificationMappings = [
  {
    type: "value",
    options: {
      contextual: { color: "semi-dark-blue", index: 2, text: "CONTEXT" },
      current: { color: "text", index: 0, text: "CURRENT" },
      derived: { color: "semi-dark-blue", index: 3, text: "DERIVED" },
      historical: { color: "blue", index: 1, text: "HISTORICAL" },
    },
  },
];

const text = (id, title, content, position, transparent = false) => ({
  id,
  title,
  type: "text",
  gridPos: position,
  options: { content, mode: "markdown" },
  transparent,
});

const statusStat = (id, title, expr, position, description) => ({
  id,
  title,
  description,
  type: "stat",
  datasource,
  gridPos: position,
  fieldConfig: {
    defaults: {
      color: { mode: "thresholds" },
      mappings: numericStatusMappings,
      thresholds: {
        mode: "absolute",
        steps: [
          { color: "gray", value: null },
          { color: "red", value: 0 },
          { color: "green", value: 1 },
        ],
      },
      unit: "short",
    },
    overrides: [],
  },
  options: {
    colorMode: "background",
    graphMode: "none",
    justifyMode: "center",
    orientation: "horizontal",
    reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
    textMode: "value",
    wideLayout: true,
  },
  targets: [target(expr)],
});

const neutralStat = (id, title, expr, position, unit = "short", description = "") => ({
  id,
  title,
  description,
  type: "stat",
  datasource,
  gridPos: position,
  fieldConfig: {
    defaults: {
      color: { fixedColor: "blue", mode: "fixed" },
      mappings: [],
      thresholds: { mode: "absolute", steps: [{ color: "blue", value: null }] },
      unit,
    },
    overrides: [],
  },
  options: {
    colorMode: "value",
    graphMode: "none",
    justifyMode: "center",
    orientation: "horizontal",
    reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
    textMode: "value",
    wideLayout: true,
  },
  targets: [target(expr)],
});

const defaultExcludedFields = {
  Time: true,
  Value: true,
  __name__: true,
  acceptance_ratio: true,
  accepted: true,
  alias: true,
  authority: true,
  budget_release: true,
  category: true,
  claim_p99_ms: true,
  classification: true,
  commands: true,
  completed: true,
  convergence: true,
  checksum: true,
  disposition: true,
  devices: true,
  drain: true,
  duplicates: true,
  environment: true,
  evidence_id: true,
  exclusion_reason: true,
  explanation: true,
  execution_profile: true,
  fact: true,
  fact_alias: true,
  gate: true,
  gate_alias: true,
  gaps: true,
  image_digest: true,
  integrity: true,
  integrity_provenance: true,
  instance: true,
  issue: true,
  issue_or_requirement: true,
  limitation: true,
  model_binding: true,
  nonterminal_runs: true,
  offered: true,
  ordering: true,
  job: true,
  link_kind: true,
  public_url: true,
  qualification_scope: true,
  record: true,
  receipt_p95_ms: true,
  receipt_p99_ms: true,
  region: true,
  repo_path: true,
  requirement: true,
  requirement_alias: true,
  resumes: true,
  run: true,
  run_id: true,
  scope: true,
  seal: true,
  source: true,
  source_alias: true,
  source_hash: true,
  status: true,
  structure: true,
  topology: true,
  topology_alias: true,
  terminal: true,
  terminal_unique: true,
  unit: true,
  unknown_outcomes: true,
  unfinished_attempts: true,
  utc: true,
  workers: true,
  stranded_work: true,
};

const table = (
  id,
  title,
  expr,
  position,
  description,
  {
    rename = {},
    order = [],
    extraExcluded = {},
    rawProvenance = false,
    statusField = "status",
    valueName,
    widths = {},
  } = {},
) => {
  const excludeByName = rawProvenance
    ? { Time: true, Value: true, __name__: true, instance: true, job: true }
    : { ...defaultExcludedFields, ...extraExcluded };
  for (const field of order) excludeByName[field] = false;
  for (const field of Object.keys(rename)) excludeByName[field] = false;
  if (valueName !== undefined) excludeByName.Value = false;
  const indexByName = Object.fromEntries(order.map((field, index) => [field, index]));
  const renameByName = valueName === undefined ? rename : { ...rename, Value: valueName };
  return {
    id,
    title,
    type: "table",
    datasource,
    description,
    gridPos: position,
    fieldConfig: {
      defaults: {},
      overrides: [
        {
          matcher: { id: "byName", options: statusField },
          properties: [
            { id: "mappings", value: stringStatusMappings },
            { id: "custom.cellOptions", value: { mode: "basic", type: "color-text" } },
          ],
        },
        {
          matcher: { id: "byName", options: "classification" },
          properties: [
            { id: "mappings", value: classificationMappings },
            { id: "custom.cellOptions", value: { mode: "basic", type: "color-text" } },
          ],
        },
        {
          matcher: { id: "byName", options: "public_url" },
          properties: [
            {
              id: "links",
              value: [{ targetBlank: true, title: "Open source", url: "${__value.raw}" }],
            },
          ],
        },
        ...Object.entries(widths).map(([field, width]) => ({
          matcher: { id: "byName", options: field },
          properties: [{ id: "custom.width", value: width }],
        })),
      ],
    },
    options: { cellHeight: "sm", showHeader: true },
    targets: [{ ...target(expr), format: "table" }],
    transformations: [
      {
        id: "organize",
        options: { excludeByName, indexByName, renameByName },
      },
    ],
  };
};

const queryVariable = (name, label, metric, field, current, includeAll = true) => ({
  name,
  label,
  type: "query",
  datasource,
  definition: `label_values(${metric}, ${field})`,
  query: { query: `label_values(${metric}, ${field})`, refId: `${name}Variable` },
  refresh: 1,
  sort: 1,
  current: { selected: true, text: current, value: current },
  options: [],
  includeAll,
  allValue: ".*",
  multi: false,
});

const commonVariables = [
  queryVariable(
    "environment",
    "Evidence environment",
    "openpoke_catalog_status",
    "environment",
    "development",
  ),
  queryVariable(
    "classification",
    "Classification",
    "openpoke_catalog_status",
    "classification",
    ".*",
  ),
  queryVariable(
    "qualification_scope",
    "Qualification scope",
    "openpoke_catalog_status",
    "qualification_scope",
    ".*",
  ),
  queryVariable("topology", "Topology", "openpoke_catalog_status", "topology", ".*"),
  queryVariable("region", "Region", "openpoke_catalog_status", "region", ".*"),
  queryVariable("status", "Status", "openpoke_catalog_status", "status", ".*"),
  queryVariable("issue", "Issue", "openpoke_catalog_status", "issue", ".*"),
  queryVariable("run", "Run", "openpoke_catalog_status", "run", ".*"),
];

const common = (title, uid, panels) => ({
  annotations: { list: [] },
  editable: false,
  fiscalYearStartMonth: 0,
  graphTooltip: 1,
  id: null,
  links: dashboardLinks,
  liveNow: false,
  panels,
  refresh: "",
  schemaVersion: 42,
  tags: ["openpoke", "evidence-catalog", "development-default"],
  templating: { list: commonVariables },
  time: { from: "now-30d", to: "now" },
  timepicker: { hidden: false },
  timezone: "utc",
  title: `OpenPoke ${title}`,
  uid,
  version: 1,
  weekStart: "monday",
});

const statusSelector =
  'environment=~"$environment",classification=~"$classification",qualification_scope=~"$qualification_scope",topology=~"$topology",region=~"$region",issue=~"$issue",run=~"$run",status=~"$status"';
const catalogStatus = (extra = "") =>
  `openpoke_catalog_status{${statusSelector}${extra === "" ? "" : `,${extra}`}}`;
const catalogFacts = (extra = "") =>
  `openpoke_catalog_fact{${statusSelector}${extra === "" ? "" : `,${extra}`}}`;
const allCatalogStatus = (extra) => `openpoke_catalog_status{${extra}}`;
const allCatalogFacts = (extra) => `openpoke_catalog_fact{${extra}}`;
const missing = (expr) => `${expr} or on() vector(-1)`;

const evidenceNotice =
  "Derived catalog view. Structured records remain authoritative. Development is the default. Historical and contextual proof never qualifies production. **MISSING** never means zero.";

const provenance = (id, y) =>
  table(
    id,
    "Raw provenance, below fold",
    `openpoke_catalog_record_info{${statusSelector}}`,
    grid(0, y, 24, 6),
    "Full identifiers and checksum provenance are intentionally confined below the first viewport.",
    {
      rawProvenance: true,
      order: ["alias", "record", "source", "authority", "disposition", "qualification_scope"],
      rename: {
        alias: "Evidence",
        authority: "Authority",
        disposition: "Disposition",
        qualification_scope: "Qualification scope",
        record: "Record ID",
        source: "Source",
      },
    },
  );

const executive = common("Executive Summary", "openpoke-executive-summary", [
  text(1, "Evidence rules", evidenceNotice, grid(0, 0, 24, 3)),
  statusStat(
    2,
    "Production qualification",
    missing(
      'max(openpoke_catalog_status{environment="production",gate="production_qualification"})',
    ),
    grid(0, 3, 6, 4),
    "Production stays MISSING until every production requirement closes.",
  ),
  statusStat(
    3,
    "Development runtime",
    missing('max(openpoke_catalog_status{environment="development",gate="development_runtime"})'),
    grid(6, 3, 6, 4),
    "This is development evidence only.",
  ),
  statusStat(
    4,
    "Bounded development SSE",
    missing('max(openpoke_catalog_status{environment="development",gate="bounded_sse"})'),
    grid(12, 3, 6, 4),
    "Failed attempts remain visible and red.",
  ),
  statusStat(
    5,
    "Catalog integrity",
    missing('max(openpoke_catalog_status{gate="catalog_integrity"})'),
    grid(18, 3, 6, 4),
    "Duplicate identifiers and checksum mismatches fail closed.",
  ),
  table(
    6,
    "Critical evidence map",
    'openpoke_catalog_status{record=~"development-runtime-current|run-short-target-232|run-sustained-target-232-rep1|historical-breaking-464|production-qualification|packet-production-saturation-bundle|packet-full-outage-recovery-bundle|packet-production-external-action-proof"}',
    grid(0, 7, 24, 9),
    "A focused PASS cannot compensate for a failed or missing production gate.",
    {
      order: [
        "alias",
        "explanation",
        "qualification_scope",
        "environment",
        "classification",
        "status",
        "limitation",
      ],
      rename: {
        alias: "Evidence",
        classification: "Class",
        environment: "Environment",
        explanation: "Result",
        limitation: "Limitation",
        qualification_scope: "Scope",
        status: "Status",
      },
    },
  ),
  text(
    7,
    "What this means",
    "**Current conclusion:** the catalog can show useful development and historical proof while production qualification remains MISSING. Red failures are not softened by green presence counts.",
    grid(0, 16, 24, 4),
  ),
  table(
    8,
    "Source coverage",
    "openpoke_catalog_source_info",
    grid(0, 22, 24, 8),
    "Every discovered source is imported, linked, represented, or excluded with a reason.",
    {
      order: [
        "source_alias",
        "category",
        "count",
        "structure",
        "seal",
        "scope",
        "disposition",
        "status",
      ],
      rename: {
        category: "Category",
        count: "Count",
        disposition: "Disposition",
        scope: "Scope",
        seal: "Seal",
        source_alias: "Source",
        status: "Status",
        structure: "Structure",
      },
      valueName: "Count",
    },
  ),
  provenance(9, 30),
]);

const development = common("Development Runtime", "openpoke-development-runtime", [
  text(1, "Evidence rules", evidenceNotice, grid(0, 0, 24, 3)),
  statusStat(
    2,
    "Runtime smoke",
    missing('max(openpoke_catalog_status{environment="development",gate="runtime_smoke"})'),
    grid(0, 3, 4, 4),
    "Sanitized development runtime result.",
  ),
  statusStat(
    3,
    "Provider run",
    missing('max(openpoke_catalog_status{environment="development",gate="provider_execution"})'),
    grid(4, 3, 4, 4),
    "Provider identity and content remain excluded.",
  ),
  statusStat(
    4,
    "Postgres match",
    missing(
      'max(openpoke_catalog_status{environment="development",gate="postgres_reconciliation"})',
    ),
    grid(8, 3, 4, 4),
    "Exact accepted work only.",
  ),
  statusStat(
    5,
    "Bounded SSE",
    missing('max(openpoke_catalog_status{environment="development",gate="bounded_sse"})'),
    grid(12, 3, 4, 4),
    "Every failed attempt remains red.",
  ),
  statusStat(
    6,
    "Fleet topology",
    missing('max(openpoke_catalog_status{environment="development",gate="runtime_topology"})'),
    grid(16, 3, 4, 4),
    "Development topology, not production qualification.",
  ),
  statusStat(
    7,
    "Production proof",
    missing(
      'max(openpoke_catalog_status{environment="production",gate="production_qualification"})',
    ),
    grid(20, 3, 4, 4),
    "Always shown so development presence cannot imply production readiness.",
  ),
  table(
    8,
    "Execution profile and image",
    'openpoke_catalog_record_info{record="development-runtime-current"}',
    grid(0, 7, 24, 4),
    "Exact sanitized provider profile and model binding. The image digest stays MISSING until a safe current digest is captured.",
    {
      order: ["alias", "execution_profile", "model_binding", "image_digest", "status"],
      rename: {
        alias: "Evidence",
        execution_profile: "Execution profile",
        image_digest: "Image digest",
        model_binding: "Model binding",
        status: "Status",
      },
      widths: {
        alias: 210,
        execution_profile: 440,
        image_digest: 130,
        model_binding: 430,
        status: 90,
      },
    },
  ),
  table(
    9,
    "Development evidence and bounded attempts",
    'openpoke_catalog_status{environment="development",classification=~"$classification",status=~"$status",category=~"development-runtime|development-sse"}',
    grid(0, 11, 24, 7),
    "Latest and failed attempts are separate rows with their exact bounded scope.",
    {
      order: ["alias", "utc", "issue", "gate_alias", "topology_alias", "status", "limitation"],
      rename: {
        alias: "Evidence",
        gate_alias: "Gate",
        issue: "Issue",
        limitation: "Limitation",
        status: "Status",
        topology_alias: "Topology",
        utc: "UTC",
      },
    },
  ),
  text(
    10,
    "What this means",
    "A healthy smoke can prove its own provider, PostgreSQL, and fleet facts. It cannot close the production matrix, overload knee, full recovery, or production ActionReceipt requirements.",
    grid(0, 18, 24, 4),
  ),
  table(
    11,
    "Sanitized development facts",
    catalogFacts('category=~"development-runtime|development-sse"'),
    grid(0, 22, 24, 8),
    "Only counts, timing, immutable profile names, and topology facts are represented.",
    {
      order: ["alias", "fact_alias", "unit", "scope"],
      rename: {
        alias: "Evidence",
        fact_alias: "Metric",
        qualification_scope: "Scope",
        unit: "Unit",
      },
      valueName: "Measured value",
    },
  ),
  provenance(12, 30),
]);

const loadAdmission = common("Load and Admission", "openpoke-load-admission", [
  text(1, "Evidence rules", evidenceNotice, grid(0, 0, 24, 3)),
  statusStat(
    2,
    "A/B/C/D admission",
    missing('min(openpoke_catalog_status{record=~"matrix-[ABCD].*",gate="admission"})'),
    grid(0, 3, 6, 4),
    "The authoritative final summary records all four cells as FAIL.",
  ),
  statusStat(
    3,
    "Receipt SLO",
    missing('min(openpoke_catalog_status{gate="receipt_under_1s",record=~"sustained.*"})'),
    grid(6, 3, 6, 4),
    "Sustained repetition 2 failed the receipt gate.",
  ),
  statusStat(
    4,
    "Accepted-work reconciliation",
    missing('min(openpoke_catalog_status{record=~"matrix-[ABCD].*",gate="reconciliation"})'),
    grid(12, 3, 6, 4),
    "Correct accepted work does not erase admission failure.",
  ),
  statusStat(
    5,
    "Production breaking point",
    missing('max(openpoke_catalog_status{environment="production",gate="breaking_point"})'),
    grid(18, 3, 6, 4),
    "No selected production overload knee exists.",
  ),
  table(
    6,
    "Authoritative admission matrix A/B/C/D",
    allCatalogStatus('record=~"matrix-[ABCD]-admission",gate="admission"'),
    grid(0, 7, 24, 9),
    "Each row preserves history, WAL envelope, accepted count, unknown outcomes, receipt latency, admission FAIL, and reconciliation PASS.",
    {
      order: [
        "alias",
        "offered",
        "accepted",
        "acceptance_ratio",
        "receipt_p95_ms",
        "receipt_p99_ms",
        "unknown_outcomes",
        "status",
      ],
      rename: {
        alias: "Cell",
        acceptance_ratio: "Accepted ratio",
        accepted: "Accepted",
        offered: "Offered",
        receipt_p95_ms: "Receipt p95 ms",
        receipt_p99_ms: "Receipt p99 ms",
        status: "Admission",
        unknown_outcomes: "Unknown",
      },
    },
  ),
  text(
    7,
    "What this means",
    "Exact demand is 232 commands/s x 1.5 = 348 AgentRuns/s. A/B/C/D is authoritative for the failed 232 messages/s production-region target. The historical 464 messages/s boundary is superseded context only.",
    grid(0, 16, 24, 4),
  ),
  table(
    8,
    "Packet runs and historical boundary",
    'openpoke_catalog_status{category=~"packet-run|historical-load"} or openpoke_catalog_status{record=~"narrative-0[89]-.*"}',
    grid(0, 22, 24, 9),
    "All 13 packet runs remain discoverable. Classification and scope prevent promotion.",
    {
      order: ["alias", "explanation", "classification", "status", "limitation"],
      rename: {
        alias: "Evidence",
        classification: "Class",
        explanation: "Result",
        limitation: "Limitation",
        status: "Status",
      },
    },
  ),
  provenance(9, 31),
]);

const postgresCapacity = common("PostgreSQL and Capacity", "openpoke-postgres-capacity", [
  text(1, "Evidence rules", evidenceNotice, grid(0, 0, 24, 3)),
  statusStat(
    2,
    "Production saturation",
    missing('max(openpoke_catalog_status{environment="production",gate="saturation"})'),
    grid(0, 3, 6, 4),
    "One locked production saturation timeline is still missing.",
  ),
  statusStat(
    3,
    "Matrix capacity",
    missing('min(openpoke_catalog_status{record=~"matrix-[ABCD].*",gate="admission"})'),
    grid(6, 3, 6, 4),
    "Larger WAL reduced churn but did not qualify admission.",
  ),
  statusStat(
    4,
    "Matrix reconciliation",
    missing('min(openpoke_catalog_status{record=~"matrix-[ABCD].*",gate="reconciliation"})'),
    grid(12, 3, 6, 4),
    "Accepted-work correctness is a separate gate.",
  ),
  neutralStat(
    5,
    "Development metadata sources",
    'count(openpoke_catalog_status{environment="development",category="cloud-monitoring-metadata"})',
    grid(18, 3, 6, 4),
    "short",
    "Presence is contextual blue, never qualification green.",
  ),
  table(
    6,
    "PostgreSQL matrix comparison",
    allCatalogFacts('record=~"matrix-[ABCD].*"'),
    grid(0, 7, 24, 9),
    "Missing measurements stay absent from facts and MISSING in their explicit gate rows.",
    {
      order: ["alias", "fact_alias", "unit", "qualification_scope"],
      rename: {
        alias: "Cell",
        fact_alias: "Metric",
        qualification_scope: "Scope",
        unit: "Unit",
      },
      valueName: "Measured value",
    },
  ),
  text(
    7,
    "What this means",
    "The final summary supports a retained-history degradation hypothesis. It does not establish a healthy production ceiling or a complete current saturation profile.",
    grid(0, 16, 24, 4),
  ),
  table(
    8,
    "Fleet and database inputs",
    allCatalogStatus('record=~"narrative-(3[8-9]|4[0-7])-.*"'),
    grid(0, 22, 12, 8),
    "Inputs are contextual and use neutral styling.",
    {
      order: ["alias", "explanation", "qualification_scope", "status"],
      rename: {
        alias: "Input",
        explanation: "Current value",
        qualification_scope: "Scope",
        status: "Qualification",
      },
    },
  ),
  table(
    9,
    "Development Cloud Monitoring metadata",
    catalogStatus('environment="development",category="cloud-monitoring-metadata"'),
    grid(12, 22, 12, 8),
    "Read-only metadata is contextual and unsealed unless an explicit sanitized snapshot says otherwise.",
    {
      order: ["alias", "classification", "status", "limitation"],
      rename: {
        alias: "Source",
        classification: "Class",
        limitation: "Limitation",
        status: "Status",
      },
    },
  ),
  provenance(10, 30),
]);

const durability = common("Durability and Recovery", "openpoke-durability-recovery", [
  text(1, "Evidence rules", evidenceNotice, grid(0, 0, 24, 3)),
  statusStat(
    2,
    "Full outage recovery",
    missing('max(openpoke_catalog_status{environment="production",gate="full_outage_recovery"})'),
    grid(0, 3, 6, 4),
    "Reserve sizing is present, the declared outage and drain are not.",
  ),
  statusStat(
    3,
    "Before-claim loss",
    missing('max(openpoke_catalog_status{gate="before_claim_loss"})'),
    grid(6, 3, 6, 4),
    "Focused non-production process cut.",
  ),
  statusStat(
    4,
    "After-claim loss",
    missing('max(openpoke_catalog_status{gate="after_claim_loss"})'),
    grid(12, 3, 6, 4),
    "Focused non-production fencing proof.",
  ),
  statusStat(
    5,
    "Historical process loss",
    missing(
      'max(openpoke_catalog_status{classification="historical",gate="process_loss_under_load"})',
    ),
    grid(18, 3, 6, 4),
    "PASS is historical context, not current production qualification.",
  ),
  table(
    6,
    "Recovery fleet screen: 4, 6, and 8 workers",
    allCatalogFacts(
      'record=~"run-recovery-rate-609-workers-[468]",fact=~"fleet.worker_instances|workload.offered|outcome.completed_agent_runs|latency.delivery_to_claim_p99_ms"',
    ),
    grid(0, 7, 24, 9),
    "The four-worker claim tail identifies why six workers remain the selected candidate. This is not a full outage test.",
    {
      order: ["alias", "fact_alias", "unit"],
      rename: {
        alias: "Fleet",
        fact_alias: "Metric",
        unit: "Unit",
      },
      valueName: "Measured value",
    },
  ),
  text(
    7,
    "What this means",
    "Focused cuts prove reclaim and fencing at their measured scope. Production still needs sustained traffic during a declared outage, visible progress within 5 minutes, full drain within 20 minutes, and exact reconciliation.",
    grid(0, 16, 24, 4),
  ),
  table(
    8,
    "Process-loss evidence",
    allCatalogStatus('gate=~"before_claim_loss|after_claim_loss|process_loss_under_load"'),
    grid(0, 22, 24, 9),
    "Focused cuts expose duplicate commits, terminal uniqueness, unfinished work, stranded work, and capacity release. Historical gaps remain MISSING.",
    {
      order: [
        "alias",
        "classification",
        "duplicates",
        "terminal_unique",
        "unfinished_attempts",
        "nonterminal_runs",
        "stranded_work",
        "budget_release",
        "status",
      ],
      rename: {
        alias: "Evidence",
        budget_release: "Budget released",
        classification: "Class",
        duplicates: "Duplicate commits",
        nonterminal_runs: "Nonterminal",
        stranded_work: "Stranded",
        status: "Status",
        terminal_unique: "Terminal unique",
        unfinished_attempts: "Unfinished",
      },
    },
  ),
  table(
    9,
    "Outstanding recovery requirements",
    'openpoke_catalog_requirement_status{issue=~"$issue",requirement=~".*recovery.*|.*outage.*|.*drain.*|.*process.*"}',
    grid(0, 31, 24, 8),
    "MISSING stays visible for every unexecuted production requirement.",
    {
      order: ["requirement_alias", "qualification_scope", "status", "explanation"],
      rename: {
        explanation: "Explanation",
        qualification_scope: "Scope",
        requirement_alias: "Requirement",
        status: "Status",
      },
    },
  ),
  provenance(10, 40),
]);

const multiDevice = common("Multi-device and Streaming", "openpoke-multi-device-streaming", [
  text(1, "Evidence rules", evidenceNotice, grid(0, 0, 24, 3)),
  statusStat(
    2,
    "Production target-load streams",
    missing('max(openpoke_catalog_status{environment="production",gate="target_load_streaming"})'),
    grid(0, 3, 6, 4),
    "No current production lane combines target load with multi-device streams.",
  ),
  statusStat(
    3,
    "Authenticated three-tab",
    missing('max(openpoke_catalog_status{gate="three_tab_resume"})'),
    grid(6, 3, 6, 4),
    "Local authenticated cursor resume and convergence.",
  ),
  statusStat(
    4,
    "Historical four-device replay",
    missing('max(openpoke_catalog_status{classification="historical",gate="four_device_replay"})'),
    grid(12, 3, 6, 4),
    "Superseded topology, preserved as context.",
  ),
  statusStat(
    5,
    "Bounded development SSE",
    missing('max(openpoke_catalog_status{environment="development",gate="bounded_sse"})'),
    grid(18, 3, 6, 4),
    "Attempts, including failures, remain separate.",
  ),
  table(
    6,
    "Streaming journeys and limitations",
    allCatalogStatus(
      'gate=~"target_load_streaming|three_tab_resume|four_device_replay|bounded_sse"',
    ),
    grid(0, 7, 24, 9),
    "Local, historical, development, and missing production evidence are never collapsed into one claim.",
    {
      order: [
        "alias",
        "classification",
        "devices",
        "resumes",
        "gaps",
        "duplicates",
        "ordering",
        "convergence",
        "status",
      ],
      rename: {
        alias: "Evidence",
        classification: "Class",
        convergence: "Converged",
        devices: "Devices",
        duplicates: "Dupes",
        gaps: "Gaps",
        ordering: "Order",
        resumes: "Replay",
        status: "Status",
      },
    },
  ),
  text(
    7,
    "What this means",
    "The local three-tab journey and historical four-device replay are useful scoped PASS results. Sender close mid-response, target load, session expiry, revocation, and production behavior remain explicit limitations.",
    grid(0, 16, 24, 4),
  ),
  table(
    8,
    "Bounded SSE attempts",
    'openpoke_catalog_status{environment="development",classification=~"$classification",status=~"$status",category="development-sse"}',
    grid(0, 22, 24, 9),
    "Every attempt records device count, commands, resume, canonical comparison, and bounded drain result without bearer or provider content.",
    {
      order: [
        "alias",
        "devices",
        "commands",
        "accepted",
        "terminal",
        "drain",
        "gaps",
        "duplicates",
        "status",
      ],
      rename: {
        accepted: "Accepted",
        alias: "Attempt",
        commands: "Commands",
        devices: "Devices",
        drain: "Drain",
        duplicates: "Dupes",
        gaps: "Gaps",
        status: "Status",
        terminal: "Terminal",
      },
    },
  ),
  provenance(9, 31),
]);

const toolCalls = common("ToolCalls and External Actions", "openpoke-toolcalls-actions", [
  text(1, "Evidence rules", evidenceNotice, grid(0, 0, 24, 3)),
  statusStat(
    2,
    "Prod ActionReceipt",
    missing('max(openpoke_catalog_status{environment="production",gate="action_receipt"})'),
    grid(0, 3, 4, 4),
    "No production external-action guarantee exists.",
  ),
  statusStat(
    3,
    "Mailpit retry",
    missing('max(openpoke_catalog_status{gate="mailpit_retry"})'),
    grid(4, 3, 4, 4),
    "Focused test sink only.",
  ),
  statusStat(
    4,
    "#67 foundation",
    missing('max(openpoke_catalog_status{record="issue-67",gate="issue_disposition"})'),
    grid(8, 3, 4, 4),
    "Durable foundation PASS. Worker, events, executor, and qualification remain MISSING.",
  ),
  statusStat(
    5,
    "#68 foundation",
    missing('max(openpoke_catalog_status{record="issue-68",gate="issue_disposition"})'),
    grid(12, 3, 4, 4),
    "Local foundation PASS. Provider, UI, routing, AgentRun, load, browser, and production qualification remain MISSING.",
  ),
  statusStat(
    6,
    "Dev provider",
    missing('max(openpoke_catalog_status{environment="development",gate="provider_execution"})'),
    grid(16, 3, 4, 4),
    "Sanitized counts only, no model or provider content.",
  ),
  statusStat(
    7,
    "Unknown outcome",
    missing(
      'max(openpoke_catalog_status{environment="production",gate="unknown_outcome_recovery"})',
    ),
    grid(20, 3, 4, 4),
    "Lost acknowledgement and reconciliation proof remain missing.",
  ),
  table(
    8,
    "External-action requirement map",
    'openpoke_catalog_requirement_status{issue=~"$issue",requirement=~"(?i).*(action|provider|idempotency|lost.ack|toolcall).*"}',
    grid(0, 7, 24, 9),
    "A Mailpit PASS cannot promote the production ActionReceipt guarantee.",
    {
      order: ["requirement_alias", "qualification_scope", "best_evidence", "status", "explanation"],
      rename: {
        best_evidence: "Best evidence",
        explanation: "Explanation",
        qualification_scope: "Scope",
        requirement_alias: "Requirement",
        status: "Status",
      },
    },
  ),
  text(
    9,
    "What this means",
    "The retained Mailpit control and current local Action foundation prove only their bounded scopes. Real provider, authenticated approval, model-selected routing, full AgentRun wait and wake, authorized content references, load, browser, and production qualification remain MISSING.",
    grid(0, 16, 24, 4),
  ),
  table(
    10,
    "Sanitized ToolCall and provider facts",
    catalogFacts('category=~"external-action|development-runtime"'),
    grid(0, 22, 24, 8),
    "Action content, model content, provider payloads, request identities, and credentials are excluded.",
    {
      order: ["alias", "fact_alias", "unit", "qualification_scope"],
      rename: {
        alias: "Evidence",
        fact_alias: "Metric",
        qualification_scope: "Scope",
        unit: "Unit",
      },
      valueName: "Measured value",
    },
  ),
  provenance(11, 30),
]);

const catalog = common("Evidence Catalog and Provenance", "openpoke-evidence-catalog", [
  text(1, "Evidence rules", evidenceNotice, grid(0, 0, 24, 3)),
  neutralStat(
    2,
    "Discovered",
    "sum(openpoke_catalog_source_info)",
    grid(0, 3, 4, 4),
    "short",
    "All discovered evidence entries.",
  ),
  neutralStat(
    3,
    "Represented",
    'sum(openpoke_catalog_source_info{disposition=~"imported|linked|represented"})',
    grid(4, 3, 4, 4),
    "short",
    "Imported, linked, or explicitly represented.",
  ),
  neutralStat(
    4,
    "Imported",
    'sum(openpoke_catalog_source_info{disposition="imported"})',
    grid(8, 3, 4, 4),
    "short",
    "Structured entries imported into the normalized catalog.",
  ),
  neutralStat(
    5,
    "Excluded",
    'sum(openpoke_catalog_source_info{disposition="excluded"})',
    grid(12, 3, 4, 4),
    "short",
    "Every exclusion requires an explicit reason.",
  ),
  statusStat(
    6,
    "Catalog integrity",
    missing('max(openpoke_catalog_status{gate="catalog_integrity"})'),
    grid(16, 3, 4, 4),
    "Duplicate identifiers and checksum mismatches fail closed.",
  ),
  statusStat(
    7,
    "Production proof",
    missing(
      'max(openpoke_catalog_status{environment="production",gate="production_qualification"})',
    ),
    grid(20, 3, 4, 4),
    "Catalog completeness does not imply product qualification.",
  ),
  table(
    8,
    "Coverage by source",
    "openpoke_catalog_source_info",
    grid(0, 7, 24, 9),
    "Repository paths are sanitized and relative. Public URLs are links, never scraped at runtime.",
    {
      order: ["source", "category", "scope", "disposition", "seal", "structure", "integrity"],
      rename: {
        category: "Category",
        disposition: "Disposition",
        integrity: "Integrity",
        scope: "Scope",
        seal: "Seal",
        source: "Source",
        structure: "Structure",
      },
      valueName: "Count",
    },
  ),
  text(
    9,
    "What this means",
    "Coverage is complete only when every relevant source has a disposition. Exclusions remain first-class catalog rows. Unsealed GitHub context can explain a requirement but can never become sealed authority.",
    grid(0, 16, 24, 4),
  ),
  table(
    10,
    "Evidence catalog",
    catalogStatus(),
    grid(0, 22, 24, 10),
    "Use the filters above to move beyond the development default. Human aliases replace full identifiers in this table.",
    {
      order: [
        "alias",
        "category",
        "utc",
        "environment",
        "classification",
        "qualification_scope",
        "gate_alias",
        "status",
        "authority",
        "limitation",
        "public_url",
      ],
      rename: {
        alias: "Evidence",
        authority: "Authority",
        category: "Category",
        classification: "Class",
        environment: "Environment",
        gate_alias: "Gate",
        limitation: "Limitation",
        public_url: "Link",
        qualification_scope: "Scope",
        status: "Status",
        utc: "UTC",
      },
    },
  ),
  table(
    11,
    "Explicit exclusions",
    'openpoke_catalog_source_info{disposition="excluded"}',
    grid(0, 32, 24, 7),
    "Exclusions cannot disappear from coverage and must state why they are unsafe or irrelevant.",
    {
      order: ["source", "category", "scope", "disposition", "seal", "structure", "integrity"],
      rename: {
        category: "Category",
        disposition: "Disposition",
        integrity: "Integrity",
        scope: "Scope",
        seal: "Seal",
        source: "Source",
        structure: "Structure",
      },
      valueName: "Count",
    },
  ),
  provenance(12, 39),
]);

const dashboards = [
  executive,
  development,
  loadAdmission,
  postgresCapacity,
  durability,
  multiDevice,
  toolCalls,
  catalog,
];

await mkdir(output, { recursive: true });
for (const filename of await readdir(output)) {
  if (filename.startsWith("openpoke-") && filename.endsWith(".json")) {
    await rm(resolve(output, filename));
  }
}

const dashboardPaths = [];
for (const dashboard of dashboards) {
  const dashboardPath = resolve(output, `${dashboard.uid}.json`);
  await writeFile(dashboardPath, `${JSON.stringify(dashboard, null, 2)}\n`);
  dashboardPaths.push(dashboardPath);
}
await execFileAsync("bunx", ["oxfmt", "--write", ...dashboardPaths]);
