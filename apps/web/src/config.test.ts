import { describe, expect, it } from "vitest";

import { resolveApiBaseURL } from "./config";

describe("resolveApiBaseURL", () => {
  it("pins an ordinary production build to the production API", () => {
    expect(
      resolveApiBaseURL({
        apiUrl: "https://untrusted.example.com",
        productionBuild: true,
        stage: undefined,
      }),
    ).toBe("https://api.osfo.ai");
  });

  it("uses the owning API Worker for a deployed preview", () => {
    expect(
      resolveApiBaseURL({
        apiUrl: "https://osfo-api-pr-187.example.workers.dev/",
        productionBuild: true,
        stage: "pr-187",
      }),
    ).toBe("https://osfo-api-pr-187.example.workers.dev");
  });

  it("pins an explicitly staged production deployment", () => {
    expect(
      resolveApiBaseURL({
        apiUrl: "https://preview.example.workers.dev",
        productionBuild: true,
        stage: "production",
      }),
    ).toBe("https://api.osfo.ai");
  });

  it("rejects a deployed preview without an owned API origin", () => {
    expect(() =>
      resolveApiBaseURL({
        apiUrl: undefined,
        productionBuild: true,
        stage: "pr-187",
      }),
    ).toThrowError("VITE_API_URL is required outside the production stage");
  });
});
