/* oxlint-disable effecttsgo/prefer-schema-over-json -- Tests inspect public JSON serialization for credential leaks and construct synthetic configuration. */
/* oxlint-disable vitest/no-standalone-expect -- The assertion executes inside the Effect returned directly to it.effect. */
import { browserHostConfig } from "@osfo/worker/config";
import { expect, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, Redacted, Result } from "effect";

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
    const remote = yield* Config.unwrap(browserHostBindings("preview")).parse(provider);
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

const productionBrowser = {
  BROWSER_HOST_ENDPOINT: "https://browser.example/inventory",
  BROWSER_HOST_OWNER_USER_ID: "test-owner",
  BROWSER_HOST_SESSION_ID: "test-extension-instance",
  BROWSER_HOST_ALLOWED_ORIGINS: '["https://portal.example"]',
  BROWSER_HOST_TOKEN: "synthetic-test-token-with-32-characters",
};

it.effect("keeps absent production browser configuration disabled", () =>
  Effect.gen(function* () {
    const bindings = yield* Config.unwrap(browserHostBindings("production")).parse(
      ConfigProvider.fromUnknown({}),
    );
    expect(bindings.BROWSER_HOST_ENDPOINT).toBe("");
    expect(bindings.BROWSER_HOST_ALLOWED_ORIGINS).toBe("[]");
    expect(Redacted.value(bindings.BROWSER_HOST_TOKEN)).toBe("");
  }),
);

it.effect("forwards complete production browser configuration with a redacted bearer", () =>
  Effect.gen(function* () {
    const bindings = yield* Config.unwrap(browserHostBindings("production")).parse(
      ConfigProvider.fromUnknown(productionBrowser),
    );
    expect(bindings).toEqual({
      ...productionBrowser,
      BROWSER_HOST_TOKEN: Redacted.make(productionBrowser.BROWSER_HOST_TOKEN),
    });
    expect(JSON.stringify(bindings)).not.toContain(productionBrowser.BROWSER_HOST_TOKEN);
  }),
);

it.effect("rejects every partial production binding without exposing credentials", () =>
  Effect.forEach(Object.keys(productionBrowser), (omitted) =>
    Effect.gen(function* () {
      const provider = ConfigProvider.fromUnknown(
        Object.fromEntries(Object.entries(productionBrowser).filter(([key]) => key !== omitted)),
      );
      const failure = yield* Effect.flip(
        Config.unwrap(browserHostBindings("production")).parse(provider),
      );
      expect(failure.message).toContain("BROWSER_HOST bindings require");
      expect(String(failure)).not.toContain(productionBrowser.BROWSER_HOST_TOKEN);
      expect(JSON.stringify(failure)).not.toContain(productionBrowser.BROWSER_HOST_TOKEN);
    }),
  ),
);

it.effect("rejects unsafe endpoints, origins, and malformed production identities", () =>
  Effect.forEach(
    [
      { BROWSER_HOST_ENDPOINT: "http://browser.example/inventory" },
      { BROWSER_HOST_ENDPOINT: "https://user:secret@browser.example/inventory" },
      { BROWSER_HOST_ENDPOINT: "https://browser.example/prefix/inventory" },
      { BROWSER_HOST_ENDPOINT: "https://browser.example/inventory?secret=value" },
      { BROWSER_HOST_ENDPOINT: "https://browser.example/inventory#fragment" },
      { BROWSER_HOST_ENDPOINT: "https://127.0.0.1/inventory" },
      { BROWSER_HOST_ENDPOINT: "https://browser.example:8443/inventory" },
      { BROWSER_HOST_ALLOWED_ORIGINS: "invalid" },
      { BROWSER_HOST_ALLOWED_ORIGINS: "[]" },
      { BROWSER_HOST_ALLOWED_ORIGINS: '["http://127.0.0.1:39271"]' },
      { BROWSER_HOST_ALLOWED_ORIGINS: '["https://portal.example/path"]' },
      { BROWSER_HOST_ALLOWED_ORIGINS: '["https://user:secret@portal.example"]' },
      {
        BROWSER_HOST_ALLOWED_ORIGINS: JSON.stringify(
          Array.from({ length: 9 }, (_, index) => `https://portal${index}.example`),
        ),
      },
      { BROWSER_HOST_OWNER_USER_ID: " " },
      { BROWSER_HOST_SESSION_ID: " test-extension-instance" },
      { BROWSER_HOST_TOKEN: "short" },
      { BROWSER_HOST_TOKEN: "x".repeat(513) },
      { BROWSER_HOST_TOKEN: " ".repeat(32) },
    ],
    (invalid) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          Config.unwrap(browserHostBindings("production")).parse(
            ConfigProvider.fromUnknown({ ...productionBrowser, ...invalid }),
          ),
        );
        expect(failure.message).toContain("BROWSER_HOST bindings require");
        expect(JSON.stringify(failure)).not.toContain(productionBrowser.BROWSER_HOST_TOKEN);
      }),
  ),
);

it("activates the runtime binding only in production or the existing local stages", () => {
  expect(Result.getOrThrow(browserHostConfig("production", productionBrowser))).toEqual({
    endpoint: productionBrowser.BROWSER_HOST_ENDPOINT,
    ownerUserId: productionBrowser.BROWSER_HOST_OWNER_USER_ID,
    hostSessionId: productionBrowser.BROWSER_HOST_SESSION_ID,
    token: Redacted.make(productionBrowser.BROWSER_HOST_TOKEN),
    allowedOrigins: ["https://portal.example"],
  });
  expect(Result.getOrThrow(browserHostConfig("production", {}))).toBeNull();
  expect(Result.getOrThrow(browserHostConfig("preview", productionBrowser))).toBeNull();
  expect(Result.getOrThrow(browserHostConfig("test", productionBrowser))).toBeNull();
  expect(
    Result.getOrThrow(
      browserHostConfig("development", {
        ...productionBrowser,
        BROWSER_HOST_ENDPOINT: "http://127.0.0.1:39270/inventory",
        BROWSER_HOST_ALLOWED_ORIGINS: "[]",
      }),
    ),
  ).toMatchObject({
    allowedOrigins: [],
    ownerUserId: productionBrowser.BROWSER_HOST_OWNER_USER_ID,
  });
});
