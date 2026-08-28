/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { ResearchReport } from "../services/research-report";
import { ResearchReportComposition } from "./research-report";

const instanceId = ResearchReport.CloudflareInstanceId.make("research:stable-instance");
const payload = ResearchReport.WorkflowPayload.make({
  inputDigest: ResearchReport.InputDigest.make("a".repeat(64)),
  workflowId: ResearchReport.WorkflowId.make(instanceId),
});

it.effect("treats a failed create as accepted only when the stable instance exists", () => {
  const calls = new Array<string>();
  const port = ResearchReportComposition.makeWorkflowPort({
    create: () => {
      calls.push("create");
      return Promise.reject(new Error("acknowledgement lost"));
    },
    get: (id) => {
      calls.push(`get:${id}`);
      return Promise.resolve({
        status: () => Promise.resolve({ status: "queued" as const }),
        terminate: () => Promise.resolve(),
      });
    },
  });

  return Effect.gen(function* () {
    yield* port.create(instanceId, payload);
    expect(calls).toEqual(["create", `get:${instanceId}`]);
  });
});

it.effect("retains create uncertainty when the stable instance is unknown", () => {
  const port = ResearchReportComposition.makeWorkflowPort({
    create: () => Promise.reject(new Error("acknowledgement lost")),
    get: () =>
      Promise.resolve({
        status: () => Promise.resolve({ status: "unknown" as const }),
        terminate: () => Promise.resolve(),
      }),
  });

  return Effect.gen(function* () {
    const result = yield* port.create(instanceId, payload).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "ResearchReportUnavailable",
        operation: "workflow.create",
      });
    }
  });
});

it.effect("makes termination an idempotent best-effort interruption", () => {
  let terminations = 0;
  let status: "running" | "terminated" = "running";
  const port = ResearchReportComposition.makeWorkflowPort({
    create: () =>
      Promise.resolve({
        status: () => Promise.resolve({ status: "queued" as const }),
        terminate: () => Promise.resolve(),
      }),
    get: () =>
      Promise.resolve({
        status: () => Promise.resolve({ status }),
        terminate: () => {
          terminations += 1;
          status = "terminated";
          return Promise.resolve();
        },
      }),
  });

  return Effect.gen(function* () {
    yield* port.terminate(instanceId);
    yield* port.terminate(instanceId);
    expect(terminations).toBe(1);
  });
});
