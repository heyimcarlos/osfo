/* oxlint-disable vitest/no-standalone-expect -- The assertion executes inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, Redacted } from "effect";

import { browserHostBindings, composioApiKeyConfig } from "./WorkerConfig";

it.effect("forwards browser bindings only for explicit local development configuration", () =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromUnknown({
      BROWSER_HOST_ENDPOINT: "http://127.0.0.1:39270/inventory",
      BROWSER_HOST_OWNER_USER_ID: "test-owner",
      BROWSER_HOST_SESSION_ID: "test-instance",
      BROWSER_HOST_TOKEN: "test-only-token",
    });
    const local = yield* Config.unwrap(browserHostBindings("development")).parse(provider);
    expect(local.BROWSER_HOST_OWNER_USER_ID).toBe("test-owner");
    expect(Redacted.value(local.BROWSER_HOST_TOKEN)).toBe("test-only-token");
    const remote = yield* Config.unwrap(browserHostBindings("production")).parse(provider);
    expect(remote.BROWSER_HOST_ENDPOINT).toBe("");
    expect(remote.BROWSER_HOST_OWNER_USER_ID).toBe("");
    expect(Redacted.value(remote.BROWSER_HOST_TOKEN)).toBe("");
  }),
);

it.effect("rejects a whitespace-only production Composio credential", () =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromUnknown({ COMPOSIO_API_KEY: "   " });
    const error = yield* Effect.flip(composioApiKeyConfig("production").parse(provider));

    expect(error.message).toContain("COMPOSIO_API_KEY must not be blank");
  }),
);
