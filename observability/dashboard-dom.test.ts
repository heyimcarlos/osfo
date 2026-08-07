import { describe, expect, it } from "@effect/vitest";

import { validateDashboardCapture, validateDashboardDom } from "./validate-dashboard-dom.js";

const expected = {
  range: "2026-08-06 20:24:10 to 2026-08-07 01:50:00 UTC",
  run: "sealed-run-id",
};

const dashboard = (content: string, controls = `${expected.run} ${expected.range}`) => `
  <main>
    <div>${controls}</div>
    <section data-testid="data-testid Panel header Scorecard">
      <div data-testid="data-testid panel content">${content}</div>
    </section>
  </main>`;

describe("Grafana DOM evidence validation", () => {
  it("accepts a populated dashboard with the selected run and locked range", () => {
    expect(validateDashboardDom(dashboard("PASS"), expected).panelCount).toBe(1);
  });

  it("accepts the DOM and PNG as one validated capture pair", () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    expect(validateDashboardCapture(dashboard("PASS"), png, expected).panelCount).toBe(1);
    expect(() => validateDashboardCapture(dashboard("PASS"), new Uint8Array(), expected)).toThrow(
      "screenshot is not a PNG",
    );
  });

  it("rejects wrong context, loading, errors, No data, and absent panels", () => {
    for (const html of [
      dashboard("PASS", expected.range),
      dashboard("PASS", expected.run),
      dashboard("Loading..."),
      dashboard("No data"),
      dashboard("Grafana has failed to load"),
      `<main>${expected.run} ${expected.range}</main>`,
    ]) {
      expect(() => validateDashboardDom(html, expected)).toThrow();
    }
  });
});
