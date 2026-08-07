import { describe, expect, it } from "@effect/vitest";

import { validateDashboardCapture, validateDashboardDom } from "./validate-dashboard-dom.js";

const expected = {
  alias: "Development runtime smoke",
  range: "2026-08-06 20:24:10 to 2026-08-07 01:50:00 UTC",
};

const dashboard = (content: string, controls = `${expected.alias} ${expected.range}`) => `
  <main>
    <div>${controls}</div>
    <section data-testid="data-testid Panel header Scorecard">
      <div data-testid="data-testid panel content">${content}</div>
    </section>
  </main>`;

const png = (width = 1920, height = 1080): Uint8Array => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

describe("Grafana DOM evidence validation", () => {
  it("accepts a populated dashboard with a human alias and locked range", () => {
    expect(validateDashboardDom(dashboard("PASS"), expected).panelCount).toBe(1);
  });

  it("requires a 1920x1080 PNG capture", () => {
    expect(validateDashboardCapture(dashboard("PASS"), png(), expected).panelCount).toBe(1);
    expect(() => validateDashboardCapture(dashboard("PASS"), new Uint8Array(), expected)).toThrow(
      "screenshot is not a PNG",
    );
    expect(() => validateDashboardCapture(dashboard("PASS"), png(1600, 900), expected)).toThrow(
      "expected 1920x1080",
    );
  });

  it("rejects wrong context, loading, errors, No data, and absent panels", () => {
    for (const html of [
      dashboard("PASS", expected.range),
      dashboard("PASS", expected.alias),
      dashboard("Loading..."),
      dashboard("No data"),
      dashboard("Grafana has failed to load"),
      `<main>${expected.alias} ${expected.range}</main>`,
    ]) {
      expect(() => validateDashboardDom(html, expected)).toThrow();
    }
  });

  it("rejects raw metric labels and full UUIDs above provenance", () => {
    for (const content of [
      "__name__",
      "openpoke_catalog_status",
      "source_hash",
      "f8ad684e-ac05-4d6d-a6ca-8b7de91e5cde",
    ]) {
      expect(() => validateDashboardDom(dashboard(content), expected)).toThrow();
    }

    expect(() =>
      validateDashboardDom(
        dashboard("PASS Raw provenance, below fold f8ad684e-ac05-4d6d-a6ca-8b7de91e5cde"),
        expected,
      ),
    ).not.toThrow();
  });
});
