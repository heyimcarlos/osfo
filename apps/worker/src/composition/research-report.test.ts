/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import { IncidentControls } from "../services/incident-controls";
import { ResearchReport } from "../services/research-report";
import { ResearchReportComposition } from "./research-report";

const instanceId = ResearchReport.CloudflareInstanceId.make("research-stable-instance");
const payload = ResearchReport.WorkflowPayload.make({
  inputDigest: ResearchReport.InputDigest.make("a".repeat(64)),
  workflowId: ResearchReport.WorkflowId.make("research:stable-workflow"),
});

it.effect("treats a failed create as accepted only when the stable instance exists", () => {
  const calls = new Array<string>();
  const port = ResearchReportComposition.makeWorkflowPort(
    {
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
    },
    Effect.void,
  );

  return Effect.gen(function* () {
    yield* port.create(instanceId, payload);
    expect(calls).toEqual(["create", "create", `get:${instanceId}`, `get:${instanceId}-timer`]);
  });
});

it.effect("retains create uncertainty when the stable instance is unknown", () => {
  const port = ResearchReportComposition.makeWorkflowPort(
    {
      create: () => Promise.reject(new Error("acknowledgement lost")),
      get: () =>
        Promise.resolve({
          status: () => Promise.resolve({ status: "unknown" as const }),
          terminate: () => Promise.resolve(),
        }),
    },
    Effect.void,
  );

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
  const port = ResearchReportComposition.makeWorkflowPort(
    {
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
    },
    Effect.void,
  );

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
    Effect.void,
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

for (const failure of [
  new IncidentControls.Paused({ control: "newCostlyWork" }),
  new IncidentControls.Unavailable({ cause: new Error("control read failed") }),
]) {
  for (const status of [
    "queued",
    "running",
    "complete",
    "errored",
    "terminated",
    "unknown",
    "missing",
    "unreadable",
  ] as const) {
    it.effect(
      `reconciles ${status} without new work when ${Schema.is(IncidentControls.Paused)(failure) ? "paused" : "unavailable"}`,
      () => {
        const calls = new Array<string>();
        const guard = Effect.fail(failure);
        const binding: ResearchReportComposition.WorkflowBinding = {
          create: () => {
            calls.push("create");
            return Promise.reject(new Error("unexpected create"));
          },
          get: () => {
            calls.push("get");
            if (status === "missing") return Promise.reject(new Error("missing instance"));
            return Promise.resolve({
              status: () =>
                status === "unreadable"
                  ? Promise.reject(new Error("status unavailable"))
                  : Promise.resolve({ status }),
              terminate: () => {
                calls.push("terminate");
                return Promise.resolve();
              },
            });
          },
        };
        return Effect.gen(function* () {
          const result = yield* ResearchReportComposition.makeWorkflowPort(binding, guard)
            .create(instanceId, payload)
            .pipe(Effect.result);
          if (status === "unknown" || status === "missing" || status === "unreadable") {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result))
              expect(result.failure).toMatchObject({ _tag: "ResearchReportUnavailable" });
          } else {
            expect(Result.isSuccess(result)).toBe(true);
            expect(calls.filter((call) => call === "get")).toHaveLength(2);
          }
          expect(calls.filter((call) => call !== "get")).toEqual([]);
        });
      },
    );
  }
}

it.effect("allows termination without evaluating the creation guard", () => {
  const calls = new Array<string>();
  const guard = Effect.suspend(() => {
    calls.push("guard");
    return Effect.fail(new IncidentControls.Paused({ control: "newCostlyWork" }));
  });
  const binding: ResearchReportComposition.WorkflowBinding = {
    create: () => Promise.reject(new Error("unexpected create")),
    get: () =>
      Promise.resolve({
        status: () => Promise.resolve({ status: "running" as const }),
        terminate: () => {
          calls.push("terminate");
          return Promise.resolve();
        },
      }),
  };
  return Effect.gen(function* () {
    yield* ResearchReportComposition.makeWorkflowPort(binding, guard).terminate(instanceId);
    expect(calls).toEqual(["terminate", "terminate"]);
  });
});
