/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
/* oxlint-disable effecttsgo/global-date -- Fixed authority fixtures prove stable deadline and timestamp behavior. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated service Layer. */
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { TestClock } from "effect/testing";

import {
  AgentId,
  AllowancePeriodId,
  ConversationRouteId,
  PlanPolicyVersion,
  SessionId,
  UserId,
} from "../domain";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import { currentResourcePriceVersion } from "../domain/usage";
import {
  approvalFor,
  ApprovalPresentation,
  emptyLiveResourceFacts,
  type AuthorizationContext,
} from "./authorization";
import { ResearchReport } from "./research-report";

const now = new Date("2026-08-27T12:00:00.000Z");
const deadline = new Date("2026-08-27T13:00:00.000Z");
const periodEndsAt = new Date("2026-09-26T12:00:00.000Z");
const userId = UserId.make("research-user");
const agentId = AgentId.make("research-agent");
const routeId = ConversationRouteId.make("research-route");
const sessionId = SessionId.make("research-session");
const actionId = ActionId.make("research-action");
const request = ResearchReport.Request.make({
  consequences: [],
  format: "pdf",
  queries: ["public evidence for the topic"],
  topic: "A bounded cited research report",
});

it.effect("starts an ordinary report without Approval and persists before Workflow create", () => {
  const fixture = makeFixture();

  return Effect.gen(function* () {
    yield* TestClock.setTime(now.getTime());
    const reports = yield* ResearchReport.Service;
    const started = yield* reports.start(startInput());

    expect(started).toMatchObject({
      _tag: "Started",
      report: {
        acceptedAt: now,
        allowancePeriodId: "research-period",
        resourcePriceVersion: currentResourcePriceVersion,
        state: "accepted",
        userId,
      },
    });
    expect(started.report.workflowId).toBe(started.report.cloudflareInstanceId);
    expect(started.report.deadlineAt).toEqual(deadline);
    expect(fixture.calls).toEqual(["persist.admit", "workflow.create", "persist.accept"]);
    expect(fixture.instances).toEqual([started.report.cloudflareInstanceId]);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("rechecks current authority on replay and rejects changed input", () => {
  const fixture = makeFixture();

  return Effect.gen(function* () {
    yield* TestClock.setTime(now.getTime());
    const reports = yield* ResearchReport.Service;
    const first = yield* reports.start(startInput());
    const deniedCurrentFacts = authorization("free");
    const deniedReplay = yield* reports
      .start(startInput({ authorization: deniedCurrentFacts }))
      .pipe(Effect.result);
    expect(deniedReplay).toMatchObject({
      failure: { _tag: "Denied", reason: "missingEntitlement" },
    });
    const replayed = yield* reports.start(startInput());
    expect(replayed).toMatchObject({ _tag: "Replayed", report: { state: "accepted" } });
    expect(replayed.report.workflowId).toBe(first.report.workflowId);

    const conflict = yield* reports
      .start(
        startInput({
          request: ResearchReport.Request.make({
            ...request,
            topic: "A materially changed report",
          }),
        }),
      )
      .pipe(Effect.result);
    expect(Result.isFailure(conflict)).toBe(true);
    if (Result.isFailure(conflict)) {
      expect(conflict.failure).toMatchObject({ _tag: "ResearchReportConflict" });
    }
    expect(fixture.instances).toHaveLength(1);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("requires Approval when the exact Workflow plan declares a protected consequence", () => {
  const fixture = makeFixture();
  const protectedRequest = ResearchReport.Request.make({
    ...request,
    consequences: ["externalCommunication"],
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(now.getTime());
    const reports = yield* ResearchReport.Service;
    const protectedActionId = ActionId.make("protected-research-action");
    const missingApproval = yield* reports
      .start(startInput({ actionId: protectedActionId, request: protectedRequest }))
      .pipe(Effect.result);
    expect(missingApproval).toMatchObject({
      failure: { _tag: "Denied", reason: "approvalRequired" },
    });

    const protectedOperation = {
      actionId: protectedActionId,
      change: "start" as const,
      consequences: protectedRequest.consequences,
      kind: "workflow.manage" as const,
    };
    const approved = yield* reports.start(
      startInput({
        actionId: protectedActionId,
        authorization: {
          ...authorization("adventurer"),
          approval: approvalFor(
            userId,
            protectedOperation,
            ApprovalPresentation.make("Send the exact completed report externally"),
          ),
        },
        request: protectedRequest,
      }),
    );
    expect(approved).toMatchObject({
      _tag: "Started",
      report: { approval: { actionId: protectedActionId } },
    });
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("reconciles a lost create acknowledgement through the same persisted identity", () => {
  const fixture = makeFixture({ failCreates: 1 });

  return Effect.gen(function* () {
    yield* TestClock.setTime(now.getTime());
    const reports = yield* ResearchReport.Service;
    const pending = yield* reports.start(startInput());
    expect(pending).toMatchObject({ _tag: "AcceptancePending", report: { state: "admitted" } });
    expect(fixture.stored?.workflowId).toBe(pending.report.workflowId);

    const accepted = yield* reports.reconcileAcceptance(
      pending.report.workflowId,
      pending.report.inputDigest,
    );
    expect(accepted).toMatchObject({ acceptedAt: now, state: "accepted" });
    expect(fixture.instances).toEqual([pending.report.cloudflareInstanceId]);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("does not collapse persistence conflicts into acceptance pending", () => {
  const fixture = makeFixture({ acceptFailure: "conflict" });

  return Effect.gen(function* () {
    const reports = yield* ResearchReport.Service;
    const result = yield* reports.start(startInput()).pipe(Effect.result);
    expect(result).toMatchObject({ failure: { _tag: "ResearchReportConflict" } });
    expect(fixture.instances).toHaveLength(1);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("does not collapse a vanished admission row into acceptance pending", () => {
  const fixture = makeFixture({ acceptFailure: "notFound" });

  return Effect.gen(function* () {
    const reports = yield* ResearchReport.Service;
    const result = yield* reports.start(startInput()).pipe(Effect.result);
    expect(result).toMatchObject({ failure: { _tag: "ResearchReportNotFound" } });
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("rechecks current authority before acceptance reconciliation", () => {
  const fixture = makeFixture({ currentPlan: "free", failCreates: 1 });

  return Effect.gen(function* () {
    const reports = yield* ResearchReport.Service;
    const pending = yield* reports.start(startInput());
    const result = yield* reports
      .reconcileAcceptance(pending.report.workflowId, pending.report.inputDigest)
      .pipe(Effect.result);
    expect(result).toMatchObject({ failure: { _tag: "Denied", reason: "missingEntitlement" } });
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("records cancellation before best-effort interruption and converges duplicates", () => {
  const fixture = makeFixture();

  return Effect.gen(function* () {
    yield* TestClock.setTime(now.getTime());
    const reports = yield* ResearchReport.Service;
    const started = yield* reports.start(startInput());
    fixture.calls.length = 0;

    const canceled = yield* reports.cancel(started.report.workflowId, userId);
    expect(canceled).toMatchObject({
      _tag: "CancelRequested",
      report: { cancelRequestedAt: now, state: "cancel_requested" },
    });
    expect(fixture.calls).toEqual(["persist.cancel", "workflow.terminate"]);

    const duplicate = yield* reports.cancel(started.report.workflowId, userId);
    expect(duplicate).toMatchObject({
      _tag: "CancelRequested",
      report: { cancelRequestedAt: now, state: "cancel_requested" },
    });
    expect(fixture.instances).toEqual([]);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("keeps retained launch-v1 Free admission fail closed", () => {
  const fixture = makeFixture();

  return Effect.gen(function* () {
    const reports = yield* ResearchReport.Service;
    const result = yield* reports
      .start(startInput({ authorization: authorization("free") }))
      .pipe(Effect.result);
    expect(result).toMatchObject({
      failure: { _tag: "Denied", reason: "missingEntitlement" },
    });
    expect(fixture.stored).toBeNull();
    expect(fixture.instances).toEqual([]);
  }).pipe(Effect.provide(layer(fixture.port)));
});

const startInput = (overrides: Partial<ResearchReport.StartInput> = {}) => ({
  actionId,
  agentId,
  authorization: authorization("adventurer"),
  request,
  routeId,
  sessionId,
  ...overrides,
});

const authorization = (plan: "adventurer" | "free"): AuthorizationContext => ({
  allowance: {
    _tag: "Metered",
    allowancePeriodId: AllowancePeriodId.make("research-period"),
    endsAt: periodEndsAt,
    plan,
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    startsAt: now,
    usage: [],
  },
  approval: null,
  authority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("research-auth-session"),
    expiresAt: periodEndsAt,
    userId,
  },
  deletionAccess: { _tag: "DeletionAccessAvailable" },
  gmailConnection: null,
  integrationConnections: [],
  liveFacts: emptyLiveResourceFacts,
  now,
  originatingAuthority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("research-auth-session"),
  },
  requestVendorUsdMicros: 0n,
  resourceOwnerUserId: userId,
  subscription: { plan, planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
  user: { _tag: "ActiveUser", userId },
});

const makeFixture = (
  options: {
    readonly acceptFailure?: "conflict" | "notFound";
    readonly currentPlan?: "adventurer" | "free";
    readonly failCreates?: number;
  } = {},
) => {
  let stored: ResearchReport.Record | null = null;
  let remainingCreateFailures = options.failCreates ?? 0;
  const calls = new Array<string>();
  const instances = new Array<ResearchReport.CloudflareInstanceId>();
  const port = ResearchReport.Port.of({
    currentAuthorization: (report) =>
      Effect.succeed({
        ...authorization(options.currentPlan ?? "adventurer"),
        approval: report.approval,
      }),
    persistence: {
      admit: (record) =>
        Effect.sync(() => {
          calls.push("persist.admit");
          if (stored !== null) return { _tag: "Existing" as const, report: stored };
          stored = record;
          return { _tag: "Created" as const, report: record };
        }),
      inspect: () => Effect.sync(() => stored),
      markAccepted: (workflowId, inputDigest, acceptedAt) =>
        Effect.gen(function* () {
          calls.push("persist.accept");
          if (options.acceptFailure === "conflict") {
            return yield* new ResearchReport.Conflict({ message: "changed digest", workflowId });
          }
          if (options.acceptFailure === "notFound") {
            return yield* new ResearchReport.NotFound({ workflowId });
          }
          if (stored === null) return yield* new ResearchReport.NotFound({ workflowId });
          if (stored.inputDigest !== inputDigest) {
            return yield* new ResearchReport.Conflict({ message: "changed digest", workflowId });
          }
          stored = { ...stored, acceptedAt, state: "accepted" };
          return stored;
        }),
      requestCancel: (workflowId, requestedUserId, requestedAt) =>
        Effect.gen(function* () {
          calls.push("persist.cancel");
          if (stored === null || stored.userId !== requestedUserId) {
            return yield* new ResearchReport.NotFound({ workflowId });
          }
          if (ResearchReport.terminalStates.has(stored.state)) return stored;
          stored =
            stored.state === "cancel_requested"
              ? stored
              : { ...stored, cancelRequestedAt: requestedAt, state: "cancel_requested" };
          return stored;
        }),
    },
    workflow: {
      create: (instanceId) =>
        Effect.gen(function* () {
          calls.push("workflow.create");
          if (remainingCreateFailures > 0) {
            remainingCreateFailures -= 1;
            return yield* new ResearchReport.Unavailable({
              cause: "lost acknowledgement",
              message: "lost acknowledgement",
              operation: "workflow.create",
            });
          }
          if (!instances.includes(instanceId)) instances.push(instanceId);
          return undefined;
        }),
      terminate: (instanceId) =>
        Effect.sync(() => {
          calls.push("workflow.terminate");
          expect(stored?.state).toBe("cancel_requested");
          const index = instances.indexOf(instanceId);
          if (index >= 0) instances.splice(index, 1);
        }),
    },
  });
  return {
    calls,
    instances,
    port,
    get stored() {
      return stored;
    },
  };
};

const layer = (port: ResearchReport.PortInterface) =>
  ResearchReport.layerWithoutDependencies.pipe(
    Layer.provide(Layer.succeed(ResearchReport.Port, port)),
  );
