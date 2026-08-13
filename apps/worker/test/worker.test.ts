import { exports } from "cloudflare:workers";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import { runHostEffect } from "../src/adapters/host";
import { decodeOsfoStage } from "../src/env";
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
        runHostEffect(makeWorkflowRuntime("workflow-1", "test"), probeExecutionUnit, "invocation"),
      );
      const secondResult = yield* Effect.promise(() =>
        runHostEffect(makeWorkflowRuntime("workflow-1", "test"), probeExecutionUnit, "invocation"),
      );

      expect(firstResult).toMatchObject({
        executionUnit: "workflow",
        identity: "workflow-1",
        stage: "test",
      });
      expect(secondResult.activationId).not.toBe(firstResult.activationId);
    }),
  );

  it("rejects an invalid stage before runtime construction", () => {
    expect(Option.isNone(decodeOsfoStage("preview"))).toBe(true);
  });
});

const decodeRuntimeProbe = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(RuntimeProbe)(body)),
  );
