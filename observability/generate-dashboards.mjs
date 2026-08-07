import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(root, "grafana/dashboards");
const execFileAsync = promisify(execFile);
const datasource = { type: "prometheus", uid: "openpoke-prometheus" };

const target = (expr, refId = "A", legendFormat = "") => ({
  datasource,
  editorMode: "code",
  expr,
  instant: true,
  legendFormat,
  range: false,
  refId,
});

const grid = (x, y, w, h) => ({ x, y, w, h });

const text = (id, title, content, position) => ({
  id,
  title,
  type: "text",
  gridPos: position,
  options: { content, mode: "markdown" },
});

const statusMappings = [
  {
    type: "value",
    options: {
      "-1": { color: "gray", index: 2, text: "MISSING" },
      0: { color: "red", index: 1, text: "FAIL" },
      1: { color: "green", index: 0, text: "PASS" },
    },
  },
];

const stat = (id, title, expr, position, options = {}) => ({
  id,
  title,
  type: "stat",
  datasource,
  gridPos: position,
  fieldConfig: {
    defaults: {
      color: { mode: options.status ? "thresholds" : "palette-classic" },
      decimals: options.decimals,
      mappings: options.status ? statusMappings : [],
      thresholds: options.status
        ? {
            mode: "absolute",
            steps: [
              { color: "gray", value: null },
              { color: "red", value: 0 },
              { color: "green", value: 1 },
            ],
          }
        : { mode: "absolute", steps: [{ color: "blue", value: null }] },
      unit: options.unit ?? "short",
    },
    overrides: [],
  },
  options: {
    colorMode: options.status ? "background" : "value",
    graphMode: "none",
    justifyMode: "auto",
    orientation: "auto",
    reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
    textMode: "auto",
    wideLayout: true,
  },
  targets: [target(expr)],
});

const table = (id, title, expr, position, description, mapStatus = false) => ({
  id,
  title,
  type: "table",
  datasource,
  description,
  gridPos: position,
  fieldConfig: {
    defaults: { mappings: mapStatus ? statusMappings : [] },
    overrides: [],
  },
  options: { cellHeight: "sm", showHeader: true },
  targets: [{ ...target(expr), format: "table" }],
});

const barGauge = (id, title, expr, position, unit = "short") => ({
  id,
  title,
  type: "bargauge",
  datasource,
  gridPos: position,
  fieldConfig: {
    defaults: {
      color: { mode: "palette-classic" },
      mappings: [],
      thresholds: { mode: "absolute", steps: [{ color: "green", value: null }] },
      unit,
    },
    overrides: [],
  },
  options: {
    displayMode: "gradient",
    minVizHeight: 10,
    minVizWidth: 0,
    namePlacement: "auto",
    orientation: "horizontal",
    reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
    showUnfilled: true,
    sizing: "auto",
    valueMode: "color",
  },
  targets: [target(expr, "A", "{{quantile}}")],
});

const runVariable = {
  name: "run",
  label: "Sealed evidence run",
  type: "query",
  datasource,
  definition: "label_values(openpoke_run_info, run)",
  query: { query: "label_values(openpoke_run_info, run)", refId: "OpenPokeRunVariable" },
  refresh: 1,
  sort: 1,
  current: {},
  options: [],
  includeAll: false,
  multi: false,
};

const dashboardLinks = [
  {
    title: "100k DAU Scorecard",
    type: "link",
    url: "/d/openpoke-100k-scorecard",
    includeVars: true,
  },
  {
    title: "Capacity and PostgreSQL",
    type: "link",
    url: "/d/openpoke-capacity-postgres",
    includeVars: true,
  },
  {
    title: "Durability and Recovery",
    type: "link",
    url: "/d/openpoke-durability-recovery",
    includeVars: true,
  },
  {
    title: "Multi-device Streams",
    type: "link",
    url: "/d/openpoke-multi-device",
    includeVars: true,
  },
  {
    title: "Topology Evolution",
    type: "link",
    url: "/d/openpoke-topology-evolution",
    includeVars: true,
  },
];

const common = (title, uid, panels, withRun = true) => ({
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
  tags: ["openpoke", "sealed-evidence", "issue-87"],
  templating: { list: withRun ? [runVariable] : [] },
  time: { from: "now-6h", to: "now" },
  timepicker: { hidden: false },
  timezone: "utc",
  title,
  uid,
  version: 1,
  weekStart: "monday",
});

const evidenceWarning = `> **Derived presentation view.** Grafana is not evidence authority. The importer verifies the sealed bundle first. Use the provenance table to locate its checksum manifest. Missing evidence stays **MISSING**.`;

const provenance = (id, y) =>
  table(
    id,
    "Evidence provenance: immutable source path and checksum-manifest hash",
    'openpoke_run_info{run="$run"}',
    grid(0, y, 24, 5),
    "The source bundle is never mutated. source_hash is SHA-256 of the verified checksum manifest.",
  );

const scorecard = common("OpenPoke 100k DAU Scorecard", "openpoke-100k-scorecard", [
  text(
    1,
    "What this proves",
    `${evidenceWarning}\n\n**Traffic model:** 100,000 DAU × 20 messages/day = 2,000,000 daily messages = 23.15 messages/s average. The 232 messages/s lane is the modeled 10× peak.`,
    grid(0, 0, 24, 4),
  ),
  stat(2, "Overall qualification", 'openpoke_run_status{run="$run"}', grid(0, 4, 4, 4), {
    status: true,
  }),
  stat(3, "Daily messages", "vector(2000000)", grid(4, 4, 4, 4), { unit: "locale" }),
  stat(4, "Daily average", "vector(2000000 / 86400)", grid(8, 4, 4, 4), {
    decimals: 2,
    unit: "reqps",
  }),
  stat(5, "Modeled 10× peak", "vector(232)", grid(12, 4, 4, 4), { unit: "reqps" }),
  stat(6, "Tested rate", 'openpoke_rate_per_second{run="$run"}', grid(16, 4, 4, 4), {
    unit: "reqps",
  }),
  stat(7, "Run duration", 'openpoke_duration_seconds{run="$run"}', grid(20, 4, 4, 4), {
    unit: "s",
  }),
  stat(8, "Offered messages", 'openpoke_count{run="$run",measure="offered"}', grid(0, 8, 4, 4), {
    unit: "locale",
  }),
  stat(9, "Durably accepted", 'openpoke_count{run="$run",measure="accepted"}', grid(4, 8, 4, 4), {
    unit: "locale",
  }),
  stat(
    10,
    "Completed root outcomes",
    'openpoke_count{run="$run",measure="completed"}',
    grid(8, 8, 4, 4),
    { unit: "locale" },
  ),
  stat(
    11,
    "Correct root outcomes",
    'openpoke_count{run="$run",measure="correct"}',
    grid(12, 8, 4, 4),
    { unit: "locale" },
  ),
  stat(
    12,
    "Durable receipt under 1s",
    'openpoke_gate_status{run="$run",gate="durable_receipt_under_1s"}',
    grid(16, 8, 4, 4),
    { status: true },
  ),
  stat(
    13,
    "First meaningful event under 10s",
    'openpoke_gate_status{run="$run",gate="first_meaningful_event_under_10s"}',
    grid(20, 8, 4, 4),
    { status: true },
  ),
  table(
    14,
    "Every acceptance gate",
    'openpoke_gate_status{run="$run"}',
    grid(0, 12, 12, 7),
    "PASS, FAIL, and MISSING are independent. Exact accepted-work reconciliation can pass while admission or latency fails.",
    true,
  ),
  table(
    15,
    "Evidence completeness",
    'openpoke_artifact_status{run="$run"}',
    grid(12, 12, 12, 7),
    "Absent scenario, audit, qualification, checkpoint, or bounded monitoring artifacts remain visible.",
    true,
  ),
  text(
    16,
    "Current breaking point",
    "The current us-east4 current-WAL result fails at authenticated admission. PostgreSQL admission stalls exhaust Cloud Run ingress capacity, produce platform 429s, and miss the one-second durable receipt SLO. Accepted work still reconciles exactly. This is a real failure result, not a topology success claim.",
    grid(0, 19, 24, 4),
  ),
  provenance(17, 23),
]);

const capacity = common("OpenPoke Capacity and PostgreSQL", "openpoke-capacity-postgres", [
  text(
    1,
    "Capacity question",
    `${evidenceWarning}\n\nThe matrix isolates history state and WAL envelope. A = clean/current WAL, B = accumulated/current WAL, C = clean/larger WAL, D = accumulated/larger WAL. Rows remain **MISSING** until a sealed bundle is imported.`,
    grid(0, 0, 24, 4),
  ),
  table(
    2,
    "Admission stability matrix A/B/C/D",
    "openpoke_matrix_cell_status",
    grid(0, 4, 8, 8),
    "The first imported A run fails. B, C, and D have no imported evidence yet.",
    true,
  ),
  stat(
    3,
    "Receipt within 1 second",
    'openpoke_receipt_within_1s_ratio{run="$run"}',
    grid(8, 4, 4, 4),
    { decimals: 3, unit: "percentunit" },
  ),
  stat(
    4,
    "Atomic admission mean",
    'openpoke_atomic_admission_mean_ms{run="$run"}',
    grid(12, 4, 4, 4),
    { decimals: 2, unit: "ms" },
  ),
  stat(
    5,
    "Cloud Run platform 429s",
    'openpoke_cloud_run_429_total{run="$run"}',
    grid(16, 4, 4, 4),
    {
      unit: "locale",
    },
  ),
  stat(6, "PostgreSQL CPU p95", 'openpoke_database_cpu_p95_ratio{run="$run"}', grid(20, 4, 4, 4), {
    decimals: 2,
    unit: "percentunit",
  }),
  barGauge(
    7,
    "Durable receipt latency",
    'openpoke_latency_ms{run="$run",operation="durable_receipt"}',
    grid(8, 8, 8, 4),
    "ms",
  ),
  barGauge(
    8,
    "PostgreSQL backends",
    'label_replace(openpoke_database_backends_p95{run="$run"}, "quantile", "p95", "__name__", ".*") or label_replace(openpoke_database_backends_max{run="$run"}, "quantile", "max", "__name__", ".*")',
    grid(16, 8, 8, 4),
  ),
  stat(9, "WAL generated", 'openpoke_database_wal_bytes{run="$run"}', grid(0, 12, 4, 4), {
    unit: "bytes",
  }),
  stat(10, "Checkpoint starts", 'openpoke_checkpoint_starts{run="$run"}', grid(4, 12, 4, 4)),
  stat(
    11,
    "Checkpoint duration p95",
    'openpoke_checkpoint_duration_p95_seconds{run="$run"}',
    grid(8, 12, 4, 4),
    { unit: "s" },
  ),
  stat(12, "Outbox relation", 'openpoke_outbox_table_bytes{run="$run"}', grid(12, 12, 4, 4), {
    unit: "bytes",
  }),
  stat(13, "Outbox indexes", 'openpoke_outbox_index_bytes{run="$run"}', grid(16, 12, 4, 4), {
    unit: "bytes",
  }),
  stat(
    14,
    "Complete durable acceptance",
    'openpoke_gate_status{run="$run",gate="complete_durable_acceptance"}',
    grid(20, 12, 4, 4),
    { status: true },
  ),
  text(
    15,
    "First saturated component",
    "**Observed:** PostgreSQL atomic admission stalls first. The effect becomes user-visible at ingress: queued requests exceed Cloud Run capacity, some receive platform 429s, and receipt p95/p99 cross the one-second SLO. Worker completion and accepted-work reconciliation remain exact, so delivery is not the first saturated module in this run.",
    grid(0, 16, 24, 5),
  ),
  provenance(16, 21),
]);

const durability = common("OpenPoke Durability and Recovery", "openpoke-durability-recovery", [
  text(
    1,
    "Durability hierarchy",
    `${evidenceWarning}\n\nProcess cuts, dependency outage, redelivery, fencing, recovery rate, and drain time require their own sealed scenarios. Exact steady-run reconciliation does not automatically certify recovery.`,
    grid(0, 0, 24, 4),
  ),
  stat(
    2,
    "Exact accepted-work reconciliation",
    'openpoke_gate_status{run="$run",gate="reconciliation"}',
    grid(0, 4, 6, 4),
    { status: true },
  ),
  stat(
    3,
    "Recovery qualification",
    'openpoke_gate_status{run="$run",gate="recovery"}',
    grid(6, 4, 6, 4),
    {
      status: true,
    },
  ),
  stat(
    4,
    "Duplicate terminal commits",
    'openpoke_integrity_violations{run="$run",kind="duplicate_terminal_commits"}',
    grid(12, 4, 6, 4),
  ),
  stat(
    5,
    "Unfinished attempts",
    'sum(openpoke_integrity_violations{run="$run",kind=~"unfinished_.*"})',
    grid(18, 4, 6, 4),
  ),
  table(
    6,
    "Integrity counters",
    'openpoke_integrity_violations{run="$run"}',
    grid(0, 8, 12, 8),
    "Zero values support exactness only for the selected sealed run.",
  ),
  table(
    7,
    "Recovery evidence still required",
    'openpoke_requirement_status{view="recovery"}',
    grid(12, 8, 12, 8),
    "MISSING is intentional until process-cut and dependency-outage bundles provide bounded recovery evidence.",
    true,
  ),
  text(
    8,
    "Recovery call graph",
    "```text\nprocess cut or outage\n  -> Pub/Sub redelivery or durable backlog\n  -> fixed StreamingPull workers reclaim with a new epoch\n  -> stale attempt is fenced\n  -> authoritative terminal commit\n  -> backlog slope turns negative\n  -> exact PostgreSQL reconciliation\n```",
    grid(0, 16, 24, 6),
  ),
  provenance(9, 22),
]);

const multiDevice = common("OpenPoke Multi-device Streams", "openpoke-multi-device", [
  text(
    1,
    "Multi-device contract",
    `${evidenceWarning}\n\nOne canonical Thread is durable in PostgreSQL. Every authenticated device owns an independent cursor, resumes by cursor, and converges on the same ordered ThreadEvent projection. No imported run proves this under load yet.`,
    grid(0, 0, 24, 4),
  ),
  stat(
    2,
    "Multi-device qualification",
    'openpoke_gate_status{run="$run",gate="multi_device"}',
    grid(0, 4, 6, 4),
    {
      status: true,
    },
  ),
  table(
    3,
    "Required stream evidence",
    'openpoke_requirement_status{view="multi_device"}',
    grid(6, 4, 18, 10),
    "Connections, cursor positions, gaps, duplicates, ordering, replay latency, and convergence stay MISSING until the real harness emits them.",
    true,
  ),
  text(
    4,
    "Per-device resume path",
    "```text\nDevice A closes mid-response\n  -> durable ThreadEvents continue committing\n  -> Device B authenticates and sends its last ThreadCursor\n  -> bounded replay starts after that ThreadPosition\n  -> replay-to-live cut preserves order\n  -> Devices B, C, and D independently advance their own cursors\n  -> every projection converges on canonical PostgreSQL history\n```",
    grid(0, 14, 24, 7),
  ),
  provenance(5, 21),
]);

const topology = common(
  "OpenPoke Topology Evolution",
  "openpoke-topology-evolution",
  [
    text(
      1,
      "Selected presentation topology",
      `${evidenceWarning}\n\n\`INTERFACE authenticated HTTP admission\` → \`DURABLE PostgreSQL authority + outbox\` → \`RUNTIME relay\` → \`DURABLE ordered Pub/Sub subscription\` → \`RUNTIME six fixed StreamingPull workers\` → \`DURABLE ThreadEvents\` → \`INTERFACE authenticated cursor SSE\`\n\nPressure is owned by PostgreSQL admission in the current failing run.`,
      grid(0, 0, 24, 5),
    ),
    table(
      2,
      "Retained and rejected decisions",
      "openpoke_topology_decision_info",
      grid(0, 5, 24, 11),
      "A retained decision is not the same as full production qualification.",
    ),
    text(
      3,
      "Evolution narrative",
      "| Step | Change | Evidence-backed decision |\n|---|---|---|\n| Direct PostgreSQL | No atomic broker handoff | Rejected, dual-write stranded and ghost work |\n| Push | Authenticated Cloud Run push | Rejected, cold-start delivery tail |\n| Corrected push | Durable publication ownership | Correctness retained, combined-load tail remained |\n| Sharded push | More subscriptions | Rejected, complexity without user-visible SLO win |\n| Durable activation | Second Pub/Sub hop | Rejected, extra authority and recovery surface |\n| Fixed StreamingPull | One ordered subscription, fixed warm fleet | Selected for predictable delivery and recovery reserve |",
      grid(0, 16, 24, 9),
    ),
  ],
  false,
);

await mkdir(output, { recursive: true });
const dashboardPaths = [];
for (const dashboard of [scorecard, capacity, durability, multiDevice, topology]) {
  const dashboardPath = resolve(output, `${dashboard.uid}.json`);
  await writeFile(dashboardPath, `${JSON.stringify(dashboard, null, 2)}\n`);
  dashboardPaths.push(dashboardPath);
}
await execFileAsync("bunx", ["oxfmt", "--write", ...dashboardPaths]);
