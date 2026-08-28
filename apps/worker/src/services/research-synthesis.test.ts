/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
/* oxlint-disable effecttsgo/global-date, effecttsgo/strict-effect-provide -- Fixed test evidence and owned Layers. */
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { TestClock } from "effect/testing";

import {
  AgentId,
  AllowancePeriodId,
  ConversationRouteId,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
  SessionId,
  UserId,
} from "../domain";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import { currentCapabilityCatalog } from "../domain/capability-catalog";
import { launchModelAccessPolicy } from "../domain/model-access-policy";
import { currentResourcePriceVersion } from "../domain/usage";
import { ResearchCollector } from "./research-collector";
import { ResearchReport } from "./research-report";
import { ResearchSynthesis } from "./research-synthesis";

const workflowId = ResearchReport.WorkflowId.make("synthesis-workflow");
const userId = UserId.make("synthesis-user");
const synthesisAttemptStartedAt = new Date("2026-08-27T12:00:00.000Z");
const synthesisAttemptExpiredAtMilliseconds = new Date("2026-08-27T12:00:36.000Z").getTime();
const report: ResearchReport.Record = {
  acceptedAt: new Date("2026-08-27T12:00:00.000Z"),
  actionId: ActionId.make("synthesis-action"),
  admittedAt: new Date("2026-08-27T12:00:00.000Z"),
  artifactContentId: null,
  artifactStoredAt: null,
  safeFailureCode: null,
  agentId: AgentId.make("synthesis-agent"),
  allowancePeriodId: AllowancePeriodId.make("synthesis-period"),
  approval: null,
  cancelRequestedAt: null,
  capabilityCatalogVersion: currentCapabilityCatalog.version,
  cloudflareInstanceId: ResearchReport.CloudflareInstanceId.make(workflowId),
  deadlineAt: new Date("2026-08-27T13:00:00.000Z"),
  inputDigest: ResearchReport.InputDigest.make("a".repeat(64)),
  manifestVersion: null,
  modelAccessPolicyVersion: ModelAccessPolicyVersion.make(
    launchModelAccessPolicy.planPolicyVersion,
  ),
  modelRoute: launchModelAccessPolicy.plans.free.route,
  originatingAuthority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("synthesis-session-authority"),
  },
  planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
  request: ResearchReport.Request.make({
    consequences: [],
    format: "pdf",
    queries: ["source query"],
    topic: "Synthesis topic",
  }),
  resourcePriceVersion: currentResourcePriceVersion,
  routeId: ConversationRouteId.make("synthesis-route"),
  sessionId: SessionId.make("synthesis-session"),
  sourceManifestKey: "users/synthesis/source-manifest.json",
  sourceManifestDigest: ResearchReport.InputDigest.make("e".repeat(64)),
  state: "sources_committed",
  startedAt: new Date("2026-08-27T12:00:01.000Z"),
  terminalAt: null,
  userId,
  workflowId,
};

const sources: ReadonlyArray<ResearchCollector.RetainedSource> = [
  {
    content: "The retained source states that launch quality improved by twelve percent.",
    source: ResearchCollector.ManifestSource.make({
      contentDigest: ResearchReport.InputDigest.make("b".repeat(64)),
      contentKey: "users/synthesis/source.json",
      fetchedAt: new Date("2026-08-27T12:05:00.000Z"),
      sourceId: "S1",
      title: "Launch study",
      url: "https://example.com/study",
    }),
  },
];

const valid = ResearchSynthesis.Result.make({
  conclusion: [claim("The evidence supports a measured improvement.")],
  sections: [{ heading: "Analysis", materialClaims: [claim("Launch quality improved.")] }],
  summary: [claim("The source reports an improvement.")],
  title: "Launch quality research report",
});

it.effect("accepts exact retained quotes and rejects unknown, absent, or fabricated evidence", () =>
  Effect.gen(function* () {
    const accepted = yield* ResearchSynthesis.validateSynthesis(valid, sources);
    expect(accepted.title).toBe(valid.title);

    const unknown = {
      ...valid,
      summary: [{ ...valid.summary[0], evidence: [{ quote: "launch quality", sourceId: "S2" }] }],
    };
    const missingQuote = {
      ...valid,
      summary: [{ ...valid.summary[0], evidence: [{ quote: "fabricated quote", sourceId: "S1" }] }],
    };
    const fabricatedUrl = { ...valid, title: "Report at https://fabricated.example" };
    for (const candidate of [unknown, missingQuote, fabricatedUrl]) {
      const result = yield* ResearchSynthesis.validateSynthesis(candidate, sources).pipe(
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.reason).toBe("fabricatedEvidence");
    }
  }),
);

it.effect(
  "persists ambiguous model acceptance as unknown with Company Cost and never retries",
  () => {
    const fixture = makeFixture("unknown");
    return Effect.gen(function* () {
      const synthesis = yield* ResearchSynthesis.Service;
      const first = yield* synthesis.synthesize(report, sources).pipe(Effect.result);
      const replay = yield* synthesis.synthesize(report, sources).pipe(Effect.result);
      expect(Result.isFailure(first)).toBe(true);
      expect(Result.isFailure(replay)).toBe(true);
      expect(fixture.providerCalls).toBe(1);
      expect(fixture.operation?.state).toBe("unknown");
      expect(fixture.costRecords).toEqual([20_000n]);
    }).pipe(Effect.provide(layer(fixture.port)));
  },
);

it.effect("replays one immutable validated synthesis without a second model call or cost", () => {
  const fixture = makeFixture("completed");
  return Effect.gen(function* () {
    const synthesis = yield* ResearchSynthesis.Service;
    const first = yield* synthesis.synthesize(report, sources);
    const replay = yield* synthesis.synthesize(report, sources);
    expect(replay.resultDigest).toBe(first.resultDigest);
    expect(fixture.providerCalls).toBe(1);
    expect(fixture.costRecords).toEqual([20_000n]);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("persists deterministic invalid output as failed with Company Cost", () => {
  const fixture = makeFixture("invalid");
  return Effect.gen(function* () {
    const synthesis = yield* ResearchSynthesis.Service;
    const first = yield* synthesis.synthesize(report, sources).pipe(Effect.result);
    const replay = yield* synthesis.synthesize(report, sources).pipe(Effect.result);
    expect(first).toMatchObject({ failure: { reason: "fabricatedEvidence" } });
    expect(replay).toMatchObject({ failure: { reason: "fabricatedEvidence" } });
    expect(fixture.operation).toMatchObject({
      companyCost: { usdMicros: 20_000n },
      safeFailureCode: "invalid-synthesis-output",
      state: "failed",
    });
    expect(fixture.providerCalls).toBe(1);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("retries Company Cost from completed PostgreSQL truth without another model call", () => {
  const fixture = makeFixture("completed", { costFailures: 1 });
  return Effect.gen(function* () {
    const synthesis = yield* ResearchSynthesis.Service;
    const first = yield* synthesis.synthesize(report, sources).pipe(Effect.result);
    expect(Result.isFailure(first)).toBe(true);
    expect(fixture.operation?.state).toBe("completed");

    const replay = yield* synthesis.synthesize(report, sources);
    expect(replay.result.title).toBe(valid.title);
    expect(fixture.providerCalls).toBe(1);
    expect(fixture.costRecords).toEqual([20_000n]);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("reconciles late immutable synthesis evidence after an unknown outcome", () => {
  const fixture = makeFixture("unknown");
  return Effect.gen(function* () {
    const synthesis = yield* ResearchSynthesis.Service;
    yield* synthesis.synthesize(report, sources).pipe(Effect.result);
    fixture.installLateEvidence();
    const recovered = yield* synthesis.synthesize(report, sources);
    expect(recovered.result.title).toBe(valid.title);
    expect(fixture.operation?.state).toBe("completed");
    expect(fixture.providerCalls).toBe(1);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("expires a crashed synthesis attempt without a second model call", () => {
  const fixture = makeFixture("completed", {
    initialPendingStartedAt: synthesisAttemptStartedAt,
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(synthesisAttemptExpiredAtMilliseconds);
    const synthesis = yield* ResearchSynthesis.Service;
    const result = yield* synthesis.synthesize(report, sources).pipe(Effect.result);
    expect(result).toMatchObject({ failure: { reason: "ambiguousOperation" } });
    expect(fixture.operation).toMatchObject({
      safeFailureCode: "expired-ambiguous-synthesis-attempt",
      state: "unknown",
    });
    expect(fixture.providerCalls).toBe(0);
  }).pipe(Effect.provide(layer(fixture.port)));
});

const makeFixture = (
  outcome: "completed" | "invalid" | "unknown",
  options: { readonly costFailures?: number; readonly initialPendingStartedAt?: Date } = {},
) => {
  let operation: ResearchSynthesis.Operation | null = null;
  let retained: {
    readonly companyCost: ResearchSynthesis.CompanyCost;
    readonly result: ResearchSynthesis.Result;
    readonly resultDigest: ResearchReport.InputDigest;
    readonly resultKey: string;
  } | null = null;
  let providerCalls = 0;
  let remainingCostFailures = options.costFailures ?? 0;
  const costRecords = new Array<bigint>();
  const companyCost = ResearchSynthesis.CompanyCost.make({
    basis: "observed",
    inputTokens: 1_000n,
    outputTokens: 500n,
    providerOperationId: "synthesis-provider-operation",
    usdMicros: 20_000n,
  });
  const port = ResearchSynthesis.Port.of({
    authorize: (current) => Effect.succeed(current),
    evidence: {
      delete: () => Effect.void,
      put: (_, __, result, retainedCost) =>
        Effect.sync(() => {
          retained = {
            companyCost: retainedCost,
            result,
            resultDigest: ResearchReport.InputDigest.make("c".repeat(64)),
            resultKey: "users/synthesis/result.json",
          };
          return retained;
        }),
      read: () => Effect.sync(() => retained?.result ?? valid),
      reconcile: () => Effect.succeed(retained),
    },
    persistence: {
      claim: (candidate) =>
        Effect.sync(() => {
          if (operation !== null) return { _tag: "Existing" as const, operation };
          if (options.initialPendingStartedAt !== undefined) {
            operation = {
              ...candidate,
              attemptCount: 1,
              startedAt: options.initialPendingStartedAt,
            };
            return { _tag: "Existing" as const, operation };
          }
          operation = candidate;
          return { _tag: "Created" as const, operation: candidate };
        }),
      complete: (candidate, completed, cost) =>
        Effect.sync(() => {
          operation = {
            ...candidate,
            companyCost: cost,
            resultDigest: completed.resultDigest,
            resultKey: completed.resultKey,
            state: "completed",
          };
          return operation;
        }),
      expireAmbiguous: (candidate, expiredBefore) =>
        Effect.sync(() => {
          if (
            operation === null ||
            candidate.startedAt === null ||
            candidate.startedAt.getTime() > expiredBefore.getTime() ||
            operation.state !== "pending" ||
            operation.attemptCount !== candidate.attemptCount
          ) {
            return false;
          }
          operation = {
            ...operation,
            safeFailureCode: "expired-ambiguous-synthesis-attempt",
            state: "unknown",
          };
          return true;
        }),
      finish: (candidate, state, _safeFailureCode, cost) =>
        Effect.sync(() => {
          operation = {
            ...candidate,
            companyCost: cost,
            safeFailureCode: _safeFailureCode,
            state,
          };
          return operation;
        }),
      recordAttempt: () =>
        Effect.sync(() => {
          if (operation === null) throw new Error("Missing synthesis operation");
          operation = {
            ...operation,
            attemptCount: operation.attemptCount + 1,
            startedAt: synthesisAttemptStartedAt,
          };
          return { _tag: "Started" as const, operation };
        }),
    },
    provider: {
      generate: () =>
        Effect.sync(() => {
          providerCalls += 1;
          return outcome === "completed"
            ? { _tag: "Completed" as const, companyCost, result: valid }
            : outcome === "invalid"
              ? { _tag: "Completed" as const, companyCost, result: null }
              : { _tag: "Unknown" as const, companyCost };
        }),
    },
    recordCompanyCost: (_, cost) =>
      Effect.gen(function* () {
        if (remainingCostFailures > 0) {
          remainingCostFailures -= 1;
          return yield* new ResearchSynthesis.Unavailable({
            cause: "ledger unavailable",
            message: "ledger unavailable",
            reason: "storageUnavailable",
          });
        }
        if (!costRecords.includes(cost.usdMicros)) costRecords.push(cost.usdMicros);
        return undefined;
      }),
  });
  return {
    costRecords,
    port,
    installLateEvidence: () => {
      retained = {
        companyCost,
        result: valid,
        resultDigest: ResearchReport.InputDigest.make("c".repeat(64)),
        resultKey: "users/synthesis/result.json",
      };
    },
    get operation() {
      return operation;
    },
    get providerCalls() {
      return providerCalls;
    },
  };
};

function claim(statement: string): ResearchSynthesis.MaterialClaim {
  return {
    evidence: [{ quote: "launch quality improved", sourceId: "S1" }],
    statement,
  };
}

const layer = (port: ResearchSynthesis.PortInterface) =>
  ResearchSynthesis.layerWithoutDependencies.pipe(
    Layer.provide(Layer.succeed(ResearchSynthesis.Port, port)),
  );
