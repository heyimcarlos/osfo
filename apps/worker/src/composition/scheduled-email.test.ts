/* oxlint-disable effecttsgo/global-date, vitest/no-standalone-expect -- Fixed Workflow boundary fixtures execute inside Effects. */
import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import { IncidentControls } from "../services/incident-controls";
import { AgentId } from "../domain";
import { IntegrationExecutionRejected } from "../services/integrations";
import { ScheduledEmail } from "../services/scheduled-email";
import { makeRecord } from "../services/scheduled-email-test-fixture";
import { makeSendReconciler, makeWorkflowPort, type WorkflowBinding } from "./scheduled-email";

const payload = ScheduledEmail.WorkflowPayload.make({
  agentId: AgentId.make("scheduled-email-agent"),
  dueAt: new Date("2026-08-28T12:00:00.000Z"),
  inputDigest: ScheduledEmail.InputDigest.make("a".repeat(64)),
  workflowId: ScheduledEmail.WorkflowId.make("scheduled-email:boundary"),
});
const instanceId = ScheduledEmail.CloudflareInstanceId.make("scheduled-email-boundary");
const sendStartedAt = new Date("2026-08-28T12:05:00.000Z");

it.effect("encodes ISO Workflow params at the Cloudflare JSON boundary", () => {
  let retained: ScheduledEmail.EncodedWorkflowPayload | null = null;
  const binding: WorkflowBinding = {
    create: ({ params }) => {
      retained = params;
      return Promise.resolve(handle("queued"));
    },
    get: () => Promise.resolve(handle("unknown")),
  };
  return Effect.gen(function* () {
    yield* makeWorkflowPort(binding, Effect.void).create(instanceId, payload);
    expect(retained).toEqual({ ...payload, dueAt: payload.dueAt.toISOString() });
  });
});

it.effect("restarts errored or terminated instances instead of accepting dead hosts", () => {
  const restarted = new Array<string>();
  const binding = (status: "errored" | "terminated"): WorkflowBinding => ({
    create: () => Promise.reject(new Error("acknowledgement lost")),
    get: () =>
      Promise.resolve({
        restart: () => {
          restarted.push(status);
          return Promise.resolve();
        },
        status: () => Promise.resolve({ status }),
        terminate: () => Promise.resolve(),
      }),
  });
  return Effect.gen(function* () {
    yield* makeWorkflowPort(binding("errored"), Effect.void).create(instanceId, payload);
    yield* makeWorkflowPort(binding("terminated"), Effect.void).create(instanceId, payload);
    expect(restarted).toEqual(["errored", "terminated"]);
  });
});

it.effect("treats malformed Applied reconciliation evidence as ambiguous provider truth", () =>
  Effect.gen(function* () {
    const reconcile = makeSendReconciler(() =>
      Effect.fail(
        new IntegrationExecutionRejected({
          code: "resultInvalid",
          message: "Applied Gmail evidence omitted its resource identity",
          operation: "GMAIL_SEND_EMAIL",
          providerLogId: "gmail-log-without-resource",
          toolkit: "gmail",
        }),
      ),
    );

    expect(
      yield* reconcile(
        makeRecord({
          sendStartedAt,
          state: "sending",
        }),
      ),
    ).toEqual({ _tag: "Ambiguous" });
  }),
);

const handle = (status: "queued" | "unknown") => ({
  restart: () => Promise.resolve(),
  status: () => Promise.resolve({ status }),
  terminate: () => Promise.resolve(),
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
        const binding: WorkflowBinding = {
          create: () => {
            calls.push("create");
            return Promise.reject(new Error("unexpected create"));
          },
          get: () => {
            calls.push("get");
            if (status === "missing") return Promise.reject(new Error("missing instance"));
            return Promise.resolve({
              restart: () => {
                calls.push("restart");
                return Promise.resolve();
              },
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
          const result = yield* makeWorkflowPort(binding, guard)
            .create(instanceId, payload)
            .pipe(Effect.result);
          if (status === "unknown" || status === "missing" || status === "unreadable") {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result))
              expect(result.failure).toMatchObject({ _tag: "ScheduledEmailUnavailable" });
          } else {
            expect(Result.isSuccess(result)).toBe(true);
            expect(calls.filter((call) => call === "get")).toHaveLength(1);
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
  const binding: WorkflowBinding = {
    create: () => Promise.reject(new Error("unexpected create")),
    get: () =>
      Promise.resolve({
        restart: () => {
          calls.push("restart");
          return Promise.resolve();
        },
        status: () => Promise.resolve({ status: "running" as const }),
        terminate: () => {
          calls.push("terminate");
          return Promise.resolve();
        },
      }),
  };
  return Effect.gen(function* () {
    yield* makeWorkflowPort(binding, guard).terminate(instanceId);
    expect(calls).toEqual(["terminate"]);
  });
});

it.effect(
  "reads the creation control again before restarting an existing terminal instance",
  () => {
    const calls = new Array<string>();
    const guard = Effect.suspend(() => {
      calls.push("guard");
      return calls.length === 1
        ? Effect.void
        : Effect.fail(new IncidentControls.Paused({ control: "newCostlyWork" }));
    });
    const binding: WorkflowBinding = {
      create: () => {
        calls.push("create");
        return Promise.reject(new Error("acknowledgement lost"));
      },
      get: () =>
        Promise.resolve({
          restart: () => {
            calls.push("restart");
            return Promise.resolve();
          },
          status: () => Promise.resolve({ status: "terminated" as const }),
          terminate: () => Promise.resolve(),
        }),
    };
    return Effect.gen(function* () {
      yield* makeWorkflowPort(binding, guard).create(instanceId, payload);
      expect(calls).toEqual(["guard", "create", "guard"]);
    });
  },
);
