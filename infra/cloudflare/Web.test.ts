import { describe, expect, it } from "vitest";

import { productionWebOrigin, webOptionsForStage } from "./Web";

describe("webOptionsForStage", () => {
  it("routes the production apex through its Worker without claiming DNS ownership", () => {
    const options = webOptionsForStage("production", "https://api.osfo.ai");

    expect(productionWebOrigin).toBe("https://osfo.ai");
    expect(options).toMatchObject({
      domain: null,
      env: {
        VITE_API_URL: "https://api.osfo.ai",
        VITE_OSFO_STAGE: "production",
      },
      routes: [{ pattern: "osfo.ai/*", zoneName: "osfo.ai" }],
    });
  });

  it("keeps preview traffic and browser configuration on the preview stage", () => {
    const options = webOptionsForStage("pr-187", "https://osfo-api-pr-187.example.workers.dev");

    expect(options).not.toHaveProperty("domain");
    expect(options).not.toHaveProperty("routes");
    expect(options.env).toEqual({
      VITE_API_URL: "https://osfo-api-pr-187.example.workers.dev",
      VITE_OSFO_STAGE: "pr-187",
    });
  });
});
