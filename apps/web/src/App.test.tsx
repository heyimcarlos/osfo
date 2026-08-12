import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "./App";

describe("App", () => {
  it("renders the reusable chat preview without application services", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Reusable chat interface");
    expect(html).toContain("What would you like to work on?");
    expect(html).toContain("UI preview");
  });
});
