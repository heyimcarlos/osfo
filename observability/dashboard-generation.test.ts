import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

interface DashboardLink {
  readonly url: string;
}

interface DashboardVariable {
  readonly current?: { readonly text?: unknown; readonly value?: unknown };
  readonly name: string;
}

interface DashboardPanel {
  readonly fieldConfig?: unknown;
  readonly gridPos: { readonly h: number; readonly y: number };
  readonly title?: string;
  readonly transformations?: ReadonlyArray<{
    readonly id: string;
    readonly options?: {
      readonly excludeByName?: Readonly<Record<string, boolean>>;
      readonly indexByName?: Readonly<Record<string, number>>;
      readonly renameByName?: Readonly<Record<string, string>>;
    };
  }>;
  readonly type: string;
}

interface DashboardDocument {
  readonly links: ReadonlyArray<DashboardLink>;
  readonly panels: ReadonlyArray<DashboardPanel>;
  readonly templating: { readonly list: ReadonlyArray<DashboardVariable> };
  readonly uid: string;
}

const dashboardDirectory = join(process.cwd(), "observability/grafana/dashboards");
const dashboardUids = [
  "openpoke-executive-summary",
  "openpoke-development-runtime",
  "openpoke-load-admission",
  "openpoke-postgres-capacity",
  "openpoke-durability-recovery",
  "openpoke-multi-device-streaming",
  "openpoke-toolcalls-actions",
  "openpoke-evidence-catalog",
] as const;

const readDashboard = async (uid: string): Promise<DashboardDocument> =>
  JSON.parse(await readFile(join(dashboardDirectory, `${uid}.json`), "utf8")) as DashboardDocument;

describe("manifest-driven evidence catalog dashboards", () => {
  it("generates exactly the required eight dashboards", async () => {
    expect(
      (await readdir(dashboardDirectory))
        .filter((filename) => filename.startsWith("openpoke-") && filename.endsWith(".json"))
        .sort(),
    ).toEqual(dashboardUids.map((uid) => `${uid}.json`).sort());
  });

  it("keeps eight-dashboard navigation and development as the default", async () => {
    const expectedUrls = dashboardUids.map((uid) => `/d/${uid}`).sort();
    for (const uid of dashboardUids) {
      const dashboard = await readDashboard(uid);
      expect(dashboard.uid).toBe(uid);
      expect(dashboard.links.map((link) => link.url).sort()).toEqual(expectedUrls);
      const environment = dashboard.templating.list.find(
        (variable) => variable.name === "environment",
      );
      expect(environment?.current?.text).toBe("development");
      expect(environment?.current?.value).toBe("development");
      expect(dashboard.templating.list.map((variable) => variable.name)).toEqual([
        "environment",
        "classification",
        "qualification_scope",
        "topology",
        "region",
        "status",
        "issue",
        "run",
      ]);
    }
  });

  it("makes the first viewport useful and keeps raw provenance below fold", async () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;
    for (const uid of dashboardUids) {
      const dashboard = await readDashboard(uid);
      const firstViewport = dashboard.panels.filter((panel) => panel.gridPos.y < 21);
      expect(firstViewport.some((panel) => panel.title === "What this means")).toBe(true);
      expect(firstViewport.some((panel) => panel.type === "stat")).toBe(true);
      expect(uuid.test(JSON.stringify(firstViewport))).toBe(false);

      const rawProvenance = dashboard.panels.find(
        (panel) => panel.title === "Raw provenance, below fold",
      );
      expect(rawProvenance?.gridPos.y).toBeGreaterThanOrEqual(21);
    }
  });

  it("organizes every table into human columns without raw Prometheus labels", async () => {
    const rawFields = ["Time", "__name__", "instance", "job"];
    const catalogFields = [
      "acceptance_ratio",
      "accepted",
      "alias",
      "authority",
      "budget_release",
      "category",
      "claim_p99_ms",
      "classification",
      "commands",
      "completed",
      "convergence",
      "devices",
      "disposition",
      "drain",
      "duplicates",
      "environment",
      "exclusion_reason",
      "explanation",
      "execution_profile",
      "fact",
      "fact_alias",
      "gate",
      "gate_alias",
      "gaps",
      "image_digest",
      "integrity",
      "integrity_provenance",
      "issue",
      "issue_or_requirement",
      "limitation",
      "model_binding",
      "nonterminal_runs",
      "offered",
      "ordering",
      "public_url",
      "qualification_scope",
      "receipt_p95_ms",
      "receipt_p99_ms",
      "record",
      "region",
      "repo_path",
      "requirement",
      "requirement_alias",
      "resumes",
      "run",
      "scope",
      "seal",
      "source",
      "status",
      "structure",
      "terminal",
      "terminal_unique",
      "topology",
      "topology_alias",
      "unit",
      "unknown_outcomes",
      "unfinished_attempts",
      "utc",
      "workers",
      "stranded_work",
    ];
    for (const uid of dashboardUids) {
      const dashboard = await readDashboard(uid);
      for (const panel of dashboard.panels.filter((candidate) => candidate.type === "table")) {
        const organize = panel.transformations?.find(
          (transformation) => transformation.id === "organize",
        );
        expect(organize).toBeDefined();
        for (const field of rawFields) {
          expect(organize?.options?.excludeByName?.[field]).toBe(true);
        }
        if (panel.title !== "Raw provenance, below fold") {
          const intentionalFields = new Set([
            ...Object.keys(organize?.options?.indexByName ?? {}),
            ...Object.keys(organize?.options?.renameByName ?? {}),
          ]);
          for (const field of catalogFields) {
            if (!intentionalFields.has(field)) {
              expect(organize?.options?.excludeByName?.[field]).toBe(true);
            }
          }
        }
        const valueHidden = organize?.options?.excludeByName?.Value === true;
        const valueRenamed =
          organize?.options?.renameByName?.Value !== undefined &&
          organize.options.renameByName.Value !== "Value";
        expect(valueHidden || valueRenamed).toBe(true);
      }
    }
  });

  it("uses only the catalog metric contract and preserves status color semantics", async () => {
    const allowedCatalogMetrics = [
      "openpoke_catalog_record_info",
      "openpoke_catalog_status",
      "openpoke_catalog_fact",
      "openpoke_catalog_requirement_status",
      "openpoke_catalog_source_info",
    ];
    for (const uid of dashboardUids) {
      const encoded = await readFile(join(dashboardDirectory, `${uid}.json`), "utf8");
      const referenced = [...encoded.matchAll(/openpoke_catalog_[a-z_]+/gu)].map(
        (match) => match[0],
      );
      expect(referenced.every((metric) => allowedCatalogMetrics.includes(metric))).toBe(true);
      expect(encoded).not.toContain("openpoke_catalog_evidence_status");
      expect(encoded).not.toContain("openpoke_catalog_coverage_status");
      expect(encoded).toContain('"-1": {');
      expect(encoded).toContain('"color": "gray"');
      expect(encoded).toContain('"color": "red"');
      expect(encoded).toContain('"color": "green"');
    }

    const executive = await readFile(
      join(dashboardDirectory, "openpoke-executive-summary.json"),
      "utf8",
    );
    const load = await readFile(join(dashboardDirectory, "openpoke-load-admission.json"), "utf8");
    expect(executive).toContain("Production qualification");
    expect(load).toContain("Authoritative admission matrix A/B/C/D");
    expect(load).toContain('record=~\\"matrix-[ABCD]-admission\\"');
    expect(load).toContain("acceptance_ratio");
    expect(load).toContain("receipt_p99_ms");

    const development = await readFile(
      join(dashboardDirectory, "openpoke-development-runtime.json"),
      "utf8",
    );
    expect(development).toContain("Execution profile and image");
    expect(development).toContain("execution_profile");
    expect(development).toContain("image_digest");
    expect(development).toContain('"custom.width"');

    const recovery = await readFile(
      join(dashboardDirectory, "openpoke-durability-recovery.json"),
      "utf8",
    );
    expect(recovery).toContain("Duplicate commits");
    expect(recovery).toContain("terminal_unique");
    expect(recovery).toContain("unfinished_attempts");
    expect(recovery).toContain("budget_release");

    const catalog = await readFile(
      join(dashboardDirectory, "openpoke-evidence-catalog.json"),
      "utf8",
    );
    expect(catalog).toContain("public_url");
    expect(catalog).toContain("${__value.raw}");
  });

  it("seals one exact 1920x1080 cockpit capture per dashboard", async () => {
    const captureRoot = join(process.cwd(), "docs/openpoke-v1-demo/assets/grafana");
    for (const uid of dashboardUids) {
      const capture = await readFile(join(captureRoot, `cockpit-${uid}.png`));
      expect([...capture.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(capture.readUInt32BE(16)).toBe(1920);
      expect(capture.readUInt32BE(20)).toBe(1080);
    }
  });
});
