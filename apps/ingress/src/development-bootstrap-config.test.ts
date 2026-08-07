import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  InvalidDevelopmentBootstrapConfig,
  resolveDevelopmentBootstrapConfig,
} from "./development-bootstrap-config";

const digest = "a".repeat(64);

describe("development demo bootstrap configuration", () => {
  it("is disabled by default in every environment", async () => {
    await expect(
      Effect.runPromise(resolveDevelopmentBootstrapConfig("development", undefined)),
    ).resolves.toEqual({ enabled: false });
    await expect(
      Effect.runPromise(resolveDevelopmentBootstrapConfig("production", undefined)),
    ).resolves.toEqual({ enabled: false });
  });

  it("enables only an exact development SHA-256 digest", async () => {
    await expect(
      Effect.runPromise(resolveDevelopmentBootstrapConfig("development", digest)),
    ).resolves.toEqual({ accessCodeSha256: digest, enabled: true });
  });

  it("rejects production enablement and malformed digests without echoing values", async () => {
    await expect(
      Effect.runPromise(resolveDevelopmentBootstrapConfig("production", digest).pipe(Effect.flip)),
    ).resolves.toEqual(new InvalidDevelopmentBootstrapConfig({ reason: "productionForbidden" }));
    await expect(
      Effect.runPromise(
        resolveDevelopmentBootstrapConfig("development", "not-a-digest").pipe(Effect.flip),
      ),
    ).resolves.toEqual(new InvalidDevelopmentBootstrapConfig({ reason: "invalidDigest" }));
  });
});
