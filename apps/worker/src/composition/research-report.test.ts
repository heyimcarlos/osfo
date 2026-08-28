/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { ResearchReport } from "../services/research-report";
import { ResearchReportComposition } from "./research-report";

const instanceId = ResearchReport.CloudflareInstanceId.make("research-stable-instance");
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
    expect(calls).toEqual(["create", "create", `get:${instanceId}`, `get:${instanceId}-timer`]);
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
  const terminations = new Array<string>();
  const statuses = new Map<string, "running" | "terminated">();
  const port = ResearchReportComposition.makeWorkflowPort({
    create: () =>
      Promise.resolve({
        status: () => Promise.resolve({ status: "queued" as const }),
        terminate: () => Promise.resolve(),
      }),
    get: (id) =>
      Promise.resolve({
        status: () => Promise.resolve({ status: statuses.get(id) ?? ("running" as const) }),
        terminate: () => {
          terminations.push(id);
          statuses.set(id, "terminated");
          return Promise.resolve();
        },
      }),
  });

  return Effect.gen(function* () {
    yield* port.terminate(instanceId);
    yield* port.terminate(instanceId);
    expect(terminations).toEqual([instanceId, `${instanceId}-timer`]);
  });
});

it.effect("does not terminate Cloudflare instances that are already non-executable", () => {
  const terminations = new Array<string>();
  const statuses = ["complete", "errored", "terminated", "unknown"] as const;
  const port = ResearchReportComposition.makeWorkflowPort(
    bindingForTerminalStatuses(statuses, terminations),
    bindingForTerminalStatuses(statuses, terminations),
  );

  return Effect.gen(function* () {
    for (const status of statuses) {
      yield* port.terminate(ResearchReport.CloudflareInstanceId.make(`research-${status}`));
    }
    expect(terminations).toEqual([]);
  });
});

const bindingForTerminalStatuses = (
  statuses: ReadonlyArray<"complete" | "errored" | "terminated" | "unknown">,
  terminations: Array<string>,
): ResearchReportComposition.WorkflowBinding => ({
  create: () => Promise.reject(new Error("Unexpected create")),
  get: (id) => {
    const status = statuses.find((candidate) => id.includes(candidate)) ?? "unknown";
    return Promise.resolve({
      status: () => Promise.resolve({ status }),
      terminate: () => {
        terminations.push(id);
        return Promise.resolve();
      },
    });
  },
});
