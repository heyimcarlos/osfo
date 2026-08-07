import { describe, expect, it } from "@effect/vitest";
import {
  DevelopmentBootstrapRateLimited,
  DevelopmentBootstrapRejected,
  DevelopmentBootstrapUnavailable,
  DevelopmentDemoBootstrap,
} from "@osfo/api";
import * as Effect from "effect/Effect";

import { makeDevelopmentDemoBootstrapLayer } from "../src/index.js";

const accessCodeSha256 = "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8";

describe("development demo bootstrap guard", () => {
  it("rejects an invalid access code before database access", async () => {
    const layer = makeDevelopmentDemoBootstrapLayer({
      accessCodeSha256,
      databaseUrl: "postgresql://unavailable.invalid/osfo",
    });

    const failure = await Effect.runPromise(
      DevelopmentDemoBootstrap.use((bootstrap) => bootstrap.create({ accessCode: "wrong" })).pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    );

    expect(failure).toEqual(new DevelopmentBootstrapRejected());
  });

  it("bounds access attempts within the configured window", async () => {
    let nowMilliseconds = Date.parse("2026-08-07T18:00:00.000Z");
    const layer = makeDevelopmentDemoBootstrapLayer({
      accessCodeSha256,
      databaseUrl: "postgresql://unavailable.invalid/osfo",
      maxAttempts: 2,
      now: () => new Date(nowMilliseconds),
      windowMilliseconds: 60_000,
    });
    const attempt = () =>
      Effect.runPromise(
        DevelopmentDemoBootstrap.use((bootstrap) => bootstrap.create({ accessCode: "wrong" })).pipe(
          Effect.provide(layer),
          Effect.flip,
        ),
      );

    expect(await attempt()).toEqual(new DevelopmentBootstrapRejected());
    nowMilliseconds += 10_000;
    expect(await attempt()).toEqual(new DevelopmentBootstrapRejected());
    nowMilliseconds += 10_000;
    expect(await attempt()).toEqual(new DevelopmentBootstrapRateLimited({ retryAfterSeconds: 40 }));
    nowMilliseconds += 40_001;
    expect(await attempt()).toEqual(new DevelopmentBootstrapRejected());
  });

  it("maps persistence failure to an opaque typed unavailable response", async () => {
    const layer = makeDevelopmentDemoBootstrapLayer({
      accessCodeSha256,
      databaseUrl: "postgresql://unavailable.invalid/osfo",
    });

    const failure = await Effect.runPromise(
      DevelopmentDemoBootstrap.use((bootstrap) =>
        bootstrap.create({ accessCode: "password" }),
      ).pipe(Effect.provide(layer), Effect.flip),
    );

    expect(failure).toEqual(new DevelopmentBootstrapUnavailable());
    expect(JSON.stringify(failure)).not.toContain("unavailable.invalid");
  });
});
