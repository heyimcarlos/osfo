import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "@osfo/ui/components/button";

describe("Button", () => {
  it("renders its public button contract", () => {
    const html = renderToStaticMarkup(<Button>Continue</Button>);

    expect(html).toContain("Continue");
    expect(html).toContain('data-slot="button"');
  });
});
