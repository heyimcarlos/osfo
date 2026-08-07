import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

const dashboardDirectory = join(process.cwd(), "observability/grafana/dashboards");
const dashboardFiles = [
  "openpoke-100k-scorecard.json",
  "openpoke-capacity-postgres.json",
  "openpoke-durability-recovery.json",
  "openpoke-multi-device.json",
  "openpoke-topology-evolution.json",
] as const;

const DashboardDocumentSchema = Schema.Struct({
  panels: Schema.Array(
    Schema.Struct({
      title: Schema.optionalKey(Schema.String),
      options: Schema.optionalKey(Schema.Struct({ content: Schema.optionalKey(Schema.String) })),
      targets: Schema.optionalKey(
        Schema.Array(Schema.Struct({ expr: Schema.optionalKey(Schema.String) })),
      ),
    }),
  ),
  templating: Schema.Struct({
    list: Schema.Array(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
  }),
});

const readDashboard = async (filename: string) =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(DashboardDocumentSchema))(
      await readFile(join(dashboardDirectory, filename), "utf8"),
    ),
  );

describe("provisioned qualification dashboards", () => {
  it("binds every dashboard and selected-run narrative to the run variable", async () => {
    for (const filename of dashboardFiles) {
      const dashboard = await readDashboard(filename);
      expect(dashboard.templating.list.some((variable) => variable.name === "run")).toBe(true);
      expect(
        dashboard.panels.some((panel) =>
          panel.targets?.some((target) => target.expr?.includes('run="$run"')),
        ),
      ).toBe(true);
    }

    for (const filename of ["openpoke-100k-scorecard.json", "openpoke-capacity-postgres.json"]) {
      const dashboard = await readDashboard(filename);
      expect(
        dashboard.panels.some(
          (panel) =>
            panel.title === "Selected run interpretation" &&
            panel.targets?.some(
              (target) => target.expr === 'openpoke_run_narrative_info{run="$run"}',
            ),
        ),
      ).toBe(true);
    }
  });

  it("suppresses the MISSING fallback when a selected-run outcome exists", async () => {
    const dashboard = await readDashboard("openpoke-100k-scorecard.json");

    for (const title of ["Completed root outcomes", "Correct root outcomes"]) {
      const panel = dashboard.panels.find((candidate) => candidate.title === title);
      expect(panel?.targets?.map((target) => target.expr)).toEqual([
        expect.stringContaining("or on() vector(-1)"),
      ]);
    }
  });

  it("presents StreamingPull as a candidate and never exposes filesystem provenance", async () => {
    for (const filename of dashboardFiles) {
      const encoded = await readFile(join(dashboardDirectory, filename), "utf8");
      expect(encoded).not.toContain("source_path");
      expect(encoded).not.toContain("immutable source path");
      expect(encoded).not.toContain("current us-east4");
      expect(encoded).not.toContain("current failing run");
    }

    const topology = await readFile(
      join(dashboardDirectory, "openpoke-topology-evolution.json"),
      "utf8",
    );
    expect(topology).toContain("selected candidate pending production qualification");
    expect(topology).not.toContain("Selected for predictable delivery");
  });
});
