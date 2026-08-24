import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Progress } from "../src/components/progress";

describe("Progress", () => {
  it("presents and fills a determinate percentage", () => {
    const html = renderToStaticMarkup(<Progress aria-label="Plan Usage remaining" value={20} />);

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="20"');
    expect(html).toContain('style="width:20%"');
  });

  it.each([
    [-1, 0],
    [101, 100],
    [Number.NaN, 0],
  ])("constrains %s to %s", (value, expected) => {
    const html = renderToStaticMarkup(<Progress aria-label="Progress" value={value} />);

    expect(html).toContain(`aria-valuenow="${expected}"`);
    expect(html).toContain(`style="width:${expected}%"`);
  });
});
