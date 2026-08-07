import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

describe("manifest-driven presentation runner", () => {
  it("accepts one output plus an optional catalog manifest", async () => {
    const script = await readFile(join(process.cwd(), "observability/run-presentation.sh"), "utf8");

    expect(script).toContain("usage: run-presentation.sh OUTPUT_DIR [CATALOG_MANIFEST]");
    expect(script).toContain("evidence-catalog.manifest.json");
    expect(script).toContain("evidence-catalog.ts");
    expect(script).toContain("OSFO_OPENPOKE_COMPOSE_PROJECT");
    expect(script).toContain("dedicated osfo-openpoke-evidence namespace");
    expect(script).toContain("for capture_attempt in {1..3}");
    expect(script).not.toContain("retained_root");
    expect(script).not.toContain("failed_root");
    expect(script).not.toContain("pilot_root");
  });

  it("captures all eight cockpit dashboards at 1920x1080", async () => {
    const script = await readFile(join(process.cwd(), "observability/run-presentation.sh"), "utf8");
    const dashboards = [
      "openpoke-executive-summary",
      "openpoke-development-runtime",
      "openpoke-load-admission",
      "openpoke-postgres-capacity",
      "openpoke-durability-recovery",
      "openpoke-multi-device-streaming",
      "openpoke-toolcalls-actions",
      "openpoke-evidence-catalog",
    ];

    for (const dashboard of dashboards) expect(script).toContain(dashboard);
    expect(script).toContain("--window-size=1920,1080");
    expect(script).toContain("var-environment=development");
  });
});
