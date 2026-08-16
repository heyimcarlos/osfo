import { exports } from "cloudflare:workers";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";

import { runInvocationEffect } from "../src/adapters/host";
import { decodeOsfoStage, decodeRuntimeConfig } from "../src/env";
import { makeWorkflowRuntime, probeExecutionUnit, RuntimeProbe } from "../src/layers";

describe("Osfo Cloudflare host", () => {
  it.effect("creates one Worker runtime for each request", () =>
    Effect.gen(function* () {
      const first = yield* Effect.promise(() =>
        exports.default.fetch(new Request("https://osfo.test/health")),
      );
      const second = yield* Effect.promise(() =>
        exports.default.fetch(new Request("https://osfo.test/health")),
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const firstProbe = yield* decodeRuntimeProbe(first);
      const secondProbe = yield* decodeRuntimeProbe(second);

      expect(firstProbe).toMatchObject({
        executionUnit: "worker",
        stage: "test",
      });
      expect(secondProbe.activationId).not.toBe(firstProbe.activationId);
    }),
  );

  it.effect("publishes the typed health contract in OpenAPI", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        exports.default.fetch(new Request("https://osfo.test/openapi.json")),
      );
      const document = yield* Effect.promise(() => response.json());

      expect(response.status).toBe(200);
      expect(document).toMatchObject({
        info: { title: "Osfo API", version: "0.1.0" },
        paths: {
          "/health": { get: { operationId: "health.get" } },
          "/v1/me/registration": {
            put: { operationId: "registration.complete" },
          },
        },
      });
    }),
  );

  it.effect("reuses one runtime inside an Osfo Agent activation", () =>
    Effect.gen(function* () {
      const first = yield* Effect.promise(() =>
        exports.default.fetch(new Request("https://osfo.test/agents/agent-1/health")),
      );
      const second = yield* Effect.promise(() =>
        exports.default.fetch(new Request("https://osfo.test/agents/agent-1/health")),
      );
      const other = yield* Effect.promise(() =>
        exports.default.fetch(new Request("https://osfo.test/agents/agent-2/health")),
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(other.status).toBe(200);

      const firstProbe = yield* decodeRuntimeProbe(first);
      const secondProbe = yield* decodeRuntimeProbe(second);
      const otherProbe = yield* decodeRuntimeProbe(other);

      expect(firstProbe).toMatchObject({
        executionUnit: "osfo-agent",
        identity: "agent-1",
        stage: "test",
      });
      expect(secondProbe.activationId).toBe(firstProbe.activationId);
      expect(otherProbe.activationId).not.toBe(firstProbe.activationId);
    }),
  );

  it.effect("creates a restricted runtime for each registration dialogue", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        exports.default.fetch(
          new Request("https://osfo.test/registration-dialogues/invitation-1/health"),
        ),
      );

      expect(response.status).toBe(200);
      const probe = yield* decodeRuntimeProbe(response);
      expect(probe).toMatchObject({
        executionUnit: "registration-dialogue",
        identity: "invitation-1",
        stage: "test",
      });
    }),
  );

  it.effect("creates and disposes one runtime for each Workflow callback", () =>
    Effect.gen(function* () {
      const firstResult = yield* Effect.promise(() =>
        runInvocationEffect(makeWorkflowRuntime("workflow-1", "test"), probeExecutionUnit),
      );
      const secondResult = yield* Effect.promise(() =>
        runInvocationEffect(makeWorkflowRuntime("workflow-1", "test"), probeExecutionUnit),
      );

      expect(firstResult).toMatchObject({
        executionUnit: "workflow",
        identity: "workflow-1",
        stage: "test",
      });
      expect(secondResult.activationId).not.toBe(firstResult.activationId);
    }),
  );

  it("accepts preview behavior but rejects infrastructure stage names", () => {
    expect(Option.isSome(decodeOsfoStage("preview"))).toBe(true);
    expect(Option.isNone(decodeOsfoStage("pr-212"))).toBe(true);
  });

  it("decodes complete authentication configuration without exposing secrets", () => {
    const decoded = decodeRuntimeConfig({
      BETTER_AUTH_API_KEY: "test-only-better-auth-dashboard-api-key",
      BETTER_AUTH_BASE_URL: "https://osfo.test",
      BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-characters",
      BETTER_AUTH_TRUSTED_ORIGINS: '["https://osfo.test"]',
      OSFO_STAGE: "test",
      TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "test-only-twilio-token",
      TWILIO_VERIFY_SERVICE_SID: `VA${"2".repeat(32)}`,
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    expect(String(decoded)).not.toContain("test-only-better-auth-dashboard-api-key");
    expect(String(decoded)).not.toContain("test-only-twilio-token");
    expect(String(decoded)).not.toContain("test-only-better-auth-secret");
  });

  it("rejects incomplete authentication configuration", () => {
    expect(Result.isFailure(decodeRuntimeConfig({ OSFO_STAGE: "test" }))).toBe(true);
  });
});

const decodeRuntimeProbe = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(RuntimeProbe)(body)),
  );
