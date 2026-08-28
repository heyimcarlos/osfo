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
    expect(started.report.cloudflareInstanceId).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u);
    expect(started.report.cloudflareInstanceId).toHaveLength(73);
    expect(started.report.workflowId).not.toBe(started.report.cloudflareInstanceId);
    const otherHostId = yield* ResearchReport.cloudflareInstanceIdFor(
      ResearchReport.WorkflowId.make(`${started.report.workflowId}-other`),
    );
    expect(otherHostId).not.toBe(started.report.cloudflareInstanceId);
    expect(started.report.deadlineAt).toEqual(deadline);
    expect(fixture.calls).toEqual([
      "persist.admit",
      "workflow.create",
      "persist.accept",
      "account.workflowStart",
    ]);
    expect(fixture.instances).toEqual([started.report.cloudflareInstanceId]);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("continues exact admitted work after a Plan downgrade and rejects changed input", () => {
  const fixture = makeFixture();

  return Effect.gen(function* () {
    yield* TestClock.setTime(now.getTime());
    const reports = yield* ResearchReport.Service;
    const first = yield* reports.start(startInput());
    const deniedCurrentFacts = authorization("free");
    const replayed = yield* reports.start(startInput({ authorization: deniedCurrentFacts }));
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

it.effect("serializes the first execution claim and replays its exact start time", () => {
  const fixture = makeFixture();

  return Effect.gen(function* () {
    yield* TestClock.setTime(now.getTime());
    const reports = yield* ResearchReport.Service;
    const started = yield* reports.start(startInput());
    const payload = ResearchReport.WorkflowPayload.make({
      inputDigest: started.report.inputDigest,
      workflowId: started.report.workflowId,
    });
    fixture.calls.length = 0;
    const [first, replay] = yield* Effect.all(
      [reports.beginExecution(payload), reports.beginExecution(payload)],
      { concurrency: "unbounded" },
    );

    expect(first).toMatchObject({ startedAt: now, state: "running" });
    expect(replay).toMatchObject({ startedAt: now, state: "running" });
    expect(fixture.calls).toEqual([
      "persist.beginExecution",
      "account.workflowStart",
      "account.workflowStart",
    ]);
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

it.effect("reconciles admitted work after downgrade against the pinned policy", () => {
  const fixture = makeFixture({ currentPlan: "free", failCreates: 1 });

  return Effect.gen(function* () {
    const reports = yield* ResearchReport.Service;
    const pending = yield* reports.start(startInput());
    const result = yield* reports.reconcileAcceptance(
      pending.report.workflowId,
      pending.report.inputDigest,
    );
    expect(result).toMatchObject({ state: "accepted" });
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("does not reapply changed Workflow capacity to exact admitted work", () => {
  const fixture = makeFixture();

  return Effect.gen(function* () {
    const reports = yield* ResearchReport.Service;
    const started = yield* reports.start(startInput());
    const replayed = yield* reports.start(
      startInput({
        authorization: {
          ...authorization("adventurer"),
          liveFacts: {
            ...emptyLiveResourceFacts,
            concurrentCostlyJobs: 100n,
            concurrentWorkflows: 100n,
          },
        },
      }),
    );
    expect(replayed.report.workflowId).toBe(started.report.workflowId);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("stops continuation after the source authority is revoked", () => {
  const fixture = makeFixture();

  return Effect.gen(function* () {
    const reports = yield* ResearchReport.Service;
    yield* reports.start(startInput());
    const revoked = authorization("adventurer");
    const result = yield* reports
      .start(
        startInput({
          authorization: {
            ...revoked,
            authority: {
              _tag: "RevokedAuthSession",
              authSessionId: AuthSessionId.make("research-auth-session"),
              userId,
            },
          },
        }),
      )
      .pipe(Effect.result);
    expect(result).toMatchObject({
      failure: { _tag: "Denied", reason: "authorityRevoked" },
    });
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("rechecks current authority before inspection or cancellation", () => {
  const fixture = makeFixture({ currentAuthorityRevoked: true });

  return Effect.gen(function* () {
    const reports = yield* ResearchReport.Service;
    const started = yield* reports.start(startInput());
    const inspected = yield* reports.inspect(started.report.workflowId, userId).pipe(Effect.result);
    const canceled = yield* reports.cancel(started.report.workflowId, userId).pipe(Effect.result);

    expect(inspected).toMatchObject({
      failure: { _tag: "Denied", reason: "authorityRevoked" },
    });
    expect(canceled).toMatchObject({
      failure: { _tag: "Denied", reason: "authorityRevoked" },
    });
    expect(fixture.calls).not.toContain("persist.cancel");
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
      report: { cancelRequestedAt: now, safeFailureCode: "cancel-requested", state: "canceled" },
    });
    expect(fixture.calls).toEqual(["persist.cancel", "followUp.terminal", "workflow.terminate"]);

    const duplicate = yield* reports.cancel(started.report.workflowId, userId);
    expect(duplicate).toMatchObject({
      _tag: "Terminal",
      report: { cancelRequestedAt: now, state: "canceled" },
    });
    expect(fixture.instances).toEqual([]);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("terminates both hosts even when the mandatory terminal follow-up needs retry", () => {
  const fixture = makeFixture({ failTerminalFollowUps: 1 });

  return Effect.gen(function* () {
    yield* TestClock.setTime(now.getTime());
    const reports = yield* ResearchReport.Service;
    const started = yield* reports.start(startInput());
    fixture.calls.length = 0;

    const first = yield* reports.cancel(started.report.workflowId, userId).pipe(Effect.result);
    expect(first).toMatchObject({ failure: { operation: "followUp.submit" } });
    expect(fixture.stored).toMatchObject({
      safeFailureCode: "cancel-requested",
      state: "canceled",
    });
    expect(fixture.calls).toEqual(["persist.cancel", "followUp.terminal", "workflow.terminate"]);
    expect(fixture.instances).toEqual([]);

    const replay = yield* reports.cancel(started.report.workflowId, userId);
    expect(replay).toMatchObject({ _tag: "Terminal", report: { state: "canceled" } });
    expect(fixture.calls).toEqual([
      "persist.cancel",
      "followUp.terminal",
      "workflow.terminate",
      "persist.cancel",
      "followUp.terminal",
      "workflow.terminate",
    ]);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("cancellation wins after artifact retention but before terminal publication", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(now.getTime());
    const reports = yield* ResearchReport.Service;
    const started = yield* reports.start(startInput());
    const payload = ResearchReport.WorkflowPayload.make({
      inputDigest: started.report.inputDigest,
      workflowId: started.report.workflowId,
    });
    yield* reports.beginExecution(payload);
    yield* reports.commitSources(
      payload,
      "users/research-user/research-report/manifests/race.json",
      ResearchReport.InputDigest.make("b".repeat(64)),
    );
    const claimed = yield* reports.claimArtifactPublication(payload, "document:workflow:race");
    expect(claimed).toMatchObject({ state: "artifact_stored" });
    expect(yield* reports.resumePublication(payload)).toMatchObject({ state: "artifact_stored" });
    const canceled = yield* reports.cancel(started.report.workflowId, userId);
    expect(canceled).toMatchObject({
      _tag: "CancelRequested",
      report: { safeFailureCode: "cancel-requested", state: "canceled" },
    });
    expect(fixture.calls).toContain("artifact.discard");
    const completed = yield* reports
      .completeSuccess(payload, "document:workflow:race")
      .pipe(Effect.result);
    expect(completed).toMatchObject({ failure: { _tag: "ResearchReportConflict" } });
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("terminal success wins a later cancellation", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(now.getTime());
    const reports = yield* ResearchReport.Service;
    const started = yield* reports.start(startInput());
    const payload = ResearchReport.WorkflowPayload.make({
      inputDigest: started.report.inputDigest,
      workflowId: started.report.workflowId,
    });
    yield* reports.beginExecution(payload);
    yield* reports.commitSources(
      payload,
      "users/research-user/research-report/manifests/success-race.json",
      ResearchReport.InputDigest.make("b".repeat(64)),
    );
    yield* reports.claimArtifactPublication(payload, "document:workflow:success-race");
    const completed = yield* reports.completeSuccess(payload, "document:workflow:success-race");
    expect(completed).toMatchObject({ safeFailureCode: null, state: "success" });
    const canceled = yield* reports.cancel(started.report.workflowId, userId);
    expect(canceled).toMatchObject({ _tag: "Terminal", report: { state: "success" } });
    expect(fixture.calls).not.toContain("artifact.discard");

    const terminalConflict = yield* reports
      .finishFailure(payload, "changed-after-publication")
      .pipe(Effect.result);
    expect(terminalConflict).toMatchObject({ failure: { _tag: "ResearchReportConflict" } });
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("cancels committed-source work while the timer host is sleeping", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(now.getTime());
    const reports = yield* ResearchReport.Service;
    const started = yield* reports.start(startInput());
    const payload = ResearchReport.WorkflowPayload.make({
      inputDigest: started.report.inputDigest,
      workflowId: started.report.workflowId,
    });
    yield* reports.beginExecution(payload);
    yield* reports.commitSources(
      payload,
      "users/research-user/research-report/manifests/sleep.json",
      ResearchReport.InputDigest.make("c".repeat(64)),
    );

    const canceled = yield* reports.cancel(started.report.workflowId, userId);
    expect(canceled).toMatchObject({
      _tag: "CancelRequested",
      report: { safeFailureCode: "cancel-requested", state: "canceled" },
    });
    expect(fixture.instances).toEqual([]);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("retains one bounded safe terminal reason and rejects changed replay", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const reports = yield* ResearchReport.Service;
    const started = yield* reports.start(startInput());
    const payload = ResearchReport.WorkflowPayload.make({
      inputDigest: started.report.inputDigest,
      workflowId: started.report.workflowId,
    });
    yield* reports.beginExecution(payload);
    const failed = yield* reports.finishFailure(payload, "invalid-synthesis-evidence");
    const replay = yield* reports.finishFailure(payload, "invalid-synthesis-evidence");
    expect(failed).toMatchObject({
      safeFailureCode: "invalid-synthesis-evidence",
      state: "failure",
    });
    expect(replay).toEqual(failed);
    const conflict = yield* reports.finishFailure(payload, "different-code").pipe(Effect.result);
    expect(conflict).toMatchObject({ failure: { _tag: "ResearchReportConflict" } });
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect(
  "commits one exact source manifest only while current execution authority remains",
  () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const reports = yield* ResearchReport.Service;
      const started = yield* reports.start(startInput());
      const payload = ResearchReport.WorkflowPayload.make({
        inputDigest: started.report.inputDigest,
        workflowId: started.report.workflowId,
      });
      const committed = yield* reports.commitSources(
        payload,
        `users/${userId}/research-report/manifests/${started.report.workflowId}.json`,
        ResearchReport.InputDigest.make("b".repeat(64)),
      );
      expect(committed).toMatchObject({
        sourceManifestKey: `users/${userId}/research-report/manifests/${started.report.workflowId}.json`,
        state: "sources_committed",
      });

      const changed = yield* reports
        .commitSources(
          payload,
          "users/changed-manifest.json",
          ResearchReport.InputDigest.make("c".repeat(64)),
        )
        .pipe(Effect.result);
      expect(changed).toMatchObject({ failure: { _tag: "ResearchReportConflict" } });
    }).pipe(Effect.provide(layer(fixture.port)));
  },
);

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

for (const [plan, activeWorkflowLimit] of [
  ["free", 3n],
  ["adventurer", 25n],
] as const) {
  it.effect(`admits ${plan} Research Reports under retained shared Usage policy`, () => {
    const fixture = makeFixture();

    return Effect.gen(function* () {
      const reports = yield* ResearchReport.Service;
      const started = yield* reports.start(
        startInput({
          authorization: authorization(plan, PlanPolicyVersion.make("shared-usage-v1")),
        }),
      );

      expect(started).toMatchObject({
        _tag: "Started",
        report: {
          modelAccessPolicyVersion: "shared-usage-v1",
          planPolicyVersion: "shared-usage-v1",
          state: "accepted",
        },
      });
      expect(fixture.activeWorkflowLimits).toEqual([activeWorkflowLimit]);
    }).pipe(Effect.provide(layer(fixture.port)));
  });
}

const startInput = (overrides: Partial<ResearchReport.StartInput> = {}) => ({
  actionId,
  agentId,
  authorization: authorization("adventurer"),
  request,
  routeId,
  sessionId,
  ...overrides,
});

const authorization = (
  plan: "adventurer" | "free",
  planPolicyVersion = PlanPolicyVersion.make("launch-v1"),
): AuthorizationContext => ({
  allowance: {
    _tag: "Metered",
    allowancePeriodId: AllowancePeriodId.make("research-period"),
    endsAt: periodEndsAt,
    plan,
    planPolicyVersion,
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
  subscription: { plan, planPolicyVersion },
  user: { _tag: "ActiveUser", userId },
});

const makeFixture = (
  options: {
    readonly acceptFailure?: "conflict" | "notFound";
    readonly currentAuthorityRevoked?: boolean;
    readonly currentPlan?: "adventurer" | "free";
    readonly failCreates?: number;
    readonly failTerminalFollowUps?: number;
  } = {},
) => {
  let stored: ResearchReport.Record | null = null;
  let remainingCreateFailures = options.failCreates ?? 0;
  let remainingFollowUpFailures = options.failTerminalFollowUps ?? 0;
  const calls = new Array<string>();
  const activeWorkflowLimits = new Array<bigint>();
  const instances = new Array<ResearchReport.CloudflareInstanceId>();
  const port = ResearchReport.Port.of({
    currentAuthorization: (report) =>
      Effect.succeed({
        ...authorization(options.currentPlan ?? "adventurer"),
        approval: report.approval,
        authority: options.currentAuthorityRevoked
          ? {
              _tag: "RevokedAuthSession" as const,
              authSessionId: AuthSessionId.make("research-auth-session"),
              userId,
            }
          : authorization(options.currentPlan ?? "adventurer").authority,
      }),
    discardPendingArtifact: (report) =>
      report.artifactContentId === null
        ? Effect.void
        : Effect.sync(() => {
            calls.push("artifact.discard");
          }),
    providerAvailable: Effect.succeed(true),
    commitTerminalFollowUp: () =>
      Effect.gen(function* () {
        calls.push("followUp.terminal");
        if (remainingFollowUpFailures > 0) {
          remainingFollowUpFailures -= 1;
          return yield* new ResearchReport.Unavailable({
            cause: "Agent unavailable",
            message: "Agent unavailable",
            operation: "followUp.submit",
          });
        }
        return undefined;
      }),
    recordWorkflowStart: () =>
      Effect.sync(() => {
        calls.push("account.workflowStart");
      }),
    persistence: {
      admit: (record, activeWorkflowLimit) =>
        Effect.sync(() => {
          calls.push("persist.admit");
          activeWorkflowLimits.push(activeWorkflowLimit);
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
      beginExecution: (workflowId, inputDigest, startedAt) =>
        Effect.gen(function* () {
          if (stored === null) return yield* new ResearchReport.NotFound({ workflowId });
          if (stored.inputDigest !== inputDigest) {
            return yield* new ResearchReport.Conflict({ message: "changed digest", workflowId });
          }
          if (stored.startedAt !== null) return stored;
          calls.push("persist.beginExecution");
          stored = {
            ...stored,
            acceptedAt: stored.acceptedAt ?? startedAt,
            startedAt,
            state: "running",
          };
          return stored;
        }),
      markSourcesCommitted: (workflowId, inputDigest, sourceManifestKey, sourceManifestDigest) =>
        Effect.gen(function* () {
          if (stored === null) return yield* new ResearchReport.NotFound({ workflowId });
          if (stored.inputDigest !== inputDigest) {
            return yield* new ResearchReport.Conflict({ message: "changed digest", workflowId });
          }
          if (stored.sourceManifestKey !== null && stored.sourceManifestKey !== sourceManifestKey) {
            return yield* new ResearchReport.Conflict({ message: "changed manifest", workflowId });
          }
          stored = {
            ...stored,
            sourceManifestDigest,
            sourceManifestKey,
            state: "sources_committed",
          };
          return stored;
        }),
      claimArtifactPublication: (workflowId, inputDigest, contentId, claimedAt) =>
        Effect.gen(function* () {
          if (stored === null) return yield* new ResearchReport.NotFound({ workflowId });
          if (stored.inputDigest !== inputDigest) {
            return yield* new ResearchReport.Conflict({ message: "changed digest", workflowId });
          }
          stored = {
            ...stored,
            artifactContentId: contentId,
            artifactStoredAt: claimedAt,
            state: "artifact_stored",
          };
          return stored;
        }),
      completeSuccess: (workflowId, inputDigest, contentId, completedAt) =>
        Effect.gen(function* () {
          if (stored === null) return yield* new ResearchReport.NotFound({ workflowId });
          if (stored.inputDigest !== inputDigest || stored.artifactContentId !== contentId) {
            return yield* new ResearchReport.Conflict({ message: "changed artifact", workflowId });
          }
          if (stored.state !== "artifact_stored") {
            return yield* new ResearchReport.Conflict({
              message: "publication race lost",
              workflowId,
            });
          }
          stored = { ...stored, state: "success", terminalAt: completedAt };
          return stored;
        }),
      finishTerminal: (workflowId, inputDigest, state, safeFailureCode, terminalAt) =>
        Effect.gen(function* () {
          if (stored === null) return yield* new ResearchReport.NotFound({ workflowId });
          if (stored.inputDigest !== inputDigest) {
            return yield* new ResearchReport.Conflict({ message: "changed digest", workflowId });
          }
          if (stored.state === state) {
            if (stored.safeFailureCode === safeFailureCode) return stored;
            return yield* new ResearchReport.Conflict({
              message: "changed terminal code",
              workflowId,
            });
          }
          if (ResearchReport.terminalStates.has(stored.state)) {
            return yield* new ResearchReport.Conflict({
              message: "terminal race lost",
              workflowId,
            });
          }
          stored = { ...stored, safeFailureCode, state, terminalAt };
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
          expect(stored?.state).toBe("canceled");
          const index = instances.indexOf(instanceId);
          if (index >= 0) instances.splice(index, 1);
        }),
    },
  });
  return {
    activeWorkflowLimits,
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
