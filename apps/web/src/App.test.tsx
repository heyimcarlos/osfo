import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("browser reference client", () => {
  it("renders a control from @osfo/ui", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Open the reference Thread");
    expect(html).toContain('data-slot="button"');
  });
});
