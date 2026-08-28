/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effects returned to it.effect. */
/* oxlint-disable effecttsgo/strict-effect-provide, effecttsgo/global-date -- Each test owns its isolated collector Layer and fixed dates are immutable evidence. */
/* oxlint-disable eslint/no-underscore-dangle -- Assertions inspect canonical tagged outcomes. */
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Result } from "effect";
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

const userId = UserId.make("collector-user");
const workflowId = ResearchReport.WorkflowId.make("collector-workflow");
const providerAttemptStartedAt = new Date("2026-08-27T12:00:00.000Z");
const providerAttemptExpiredAtMilliseconds = new Date("2026-08-27T12:00:36.000Z").getTime();
const report: ResearchReport.Record = {
  acceptedAt: new Date("2026-08-27T12:00:00.000Z"),
  actionId: ActionId.make("collector-action"),
  admittedAt: new Date("2026-08-27T12:00:00.000Z"),
  artifactContentId: null,
  artifactStoredAt: null,
  safeFailureCode: null,
  agentId: AgentId.make("collector-agent"),
  allowancePeriodId: AllowancePeriodId.make("collector-period"),
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
  modelRoute: launchModelAccessPolicy.plans.adventurer.route,
  originatingAuthority: {
    _tag: "AuthSession",
    authSessionId: AuthSessionId.make("collector-auth-session"),
  },
  planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
  request: ResearchReport.Request.make({
    consequences: [],
    format: "pdf",
    queries: ["public source query"],
    topic: "A cited report",
  }),
  resourcePriceVersion: currentResourcePriceVersion,
  routeId: ConversationRouteId.make("collector-route"),
  sessionId: SessionId.make("collector-session"),
  sourceManifestKey: null,
  sourceManifestDigest: null,
  state: "accepted",
  startedAt: new Date("2026-08-27T12:00:01.000Z"),
  terminalAt: null,
  userId,
  workflowId,
};

it.effect("retains source bodies only in R2 evidence and cites fetched pages only", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const collector = yield* ResearchCollector.Service;
    const collection = yield* collector.collect(report);

    expect(collection.manifest.sources).toHaveLength(1);
    expect(collection.manifestDigest).toBe("c".repeat(64));
    expect(collection.manifest.sources[0]).toMatchObject({
      contentKey: `users/${userId}/research/source.json`,
      url: "https://example.com/source",
    });
    expect(fixture.evidenceBodies).toEqual(["FETCHED_BODY_TEXT"]);
    for (const operation of fixture.operations.values()) {
      if (operation.result?._tag === "Search") {
        expect(operation.result.results.every((result) => !("description" in result))).toBe(true);
      }
      if (operation.result?._tag === "Page") {
        expect("content" in operation.result).toBe(false);
      }
    }
    expect(collection.manifest.sources.every((source) => !("content" in source))).toBe(true);
    expect(collection.manifest.sources.every((source) => !("description" in source))).toBe(true);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("deduplicates canonical variants before assigning page-operation identity", () => {
  const fixture = makeFixture({ duplicateUrlVariants: true });
  return Effect.gen(function* () {
    const collector = yield* ResearchCollector.Service;
    const collection = yield* collector.collect(report);
    expect(fixture.pageFetchCalls).toBe(1);
    expect(collection.manifest.sources).toHaveLength(1);
    expect(collection.manifest.sources[0]?.url).toBe("https://example.com/source");
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect(
  "reads only the committed manifest identity and rejects corrupt Workflow ownership",
  () => {
    const validFixture = makeFixture();
    const corruptFixture = makeFixture({ corruptManifestWorkflow: true });
    const verify = (fixture: ReturnType<typeof makeFixture>) =>
      Effect.gen(function* () {
        const collector = yield* ResearchCollector.Service;
        const collection = yield* collector.collect(report);
        const committed: ResearchReport.Record = {
          ...report,
          sourceManifestDigest: collection.manifestDigest,
          sourceManifestKey: collection.manifestKey,
          state: "sources_committed",
        };
        return yield* collector.read(committed, collection);
      }).pipe(Effect.provide(layer(fixture.port)));
    return Effect.gen(function* () {
      const retained = yield* verify(validFixture);
      expect(retained).toMatchObject([
        { content: "FETCHED_BODY_TEXT", source: { sourceId: "S1" } },
      ]);
      const corrupt = yield* verify(corruptFixture).pipe(Effect.result);
      expect(corrupt).toMatchObject({ failure: { reason: "insufficientEvidence" } });
    });
  },
);

it.effect("retries one typed transient idempotent page GET and records both attempts", () => {
  const fixture = makeFixture({ transientPageFailures: 1 });
  return Effect.gen(function* () {
    const collector = yield* ResearchCollector.Service;
    yield* collector.collect(report);
    expect(fixture.pageFetchCalls).toBe(2);
    expect(fixture.operations.get(`${workflowId}:provider:1`)?.attemptCount).toBe(2);
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("persists rejected discovery acceptance as unknown without retry", () => {
  const fixture = makeFixture({ ambiguousDiscoveryFailures: 1 });
  return Effect.gen(function* () {
    const collector = yield* ResearchCollector.Service;
    const result = yield* collector.collect(report).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(fixture.discoveryCalls).toBe(1);
    expect(fixture.operations.get(`${workflowId}:provider:0`)?.state).toBe("unknown");
    expect(fixture.failureCodes.get(`${workflowId}:provider:0`)).toBe(
      "ambiguous-provider-acceptance-company-cost",
    );
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("allows only one concurrent execution to cross the provider-attempt CAS", () =>
  Effect.gen(function* () {
    const bothClaimed = yield* Deferred.make<void>();
    let claimCount = 0;
    const fixture = makeFixture({
      beforeClaimReturn: () =>
        Effect.sync(() => {
          claimCount += 1;
          return claimCount;
        }).pipe(
          Effect.flatMap((count) =>
            count === 2 ? Deferred.succeed(bothClaimed, undefined) : Deferred.await(bothClaimed),
          ),
          Effect.asVoid,
        ),
    });
    const run = Effect.gen(function* () {
      const collector = yield* ResearchCollector.Service;
      return yield* collector.collect(report);
    }).pipe(Effect.provide(layer(fixture.port)), Effect.result);
    const first = yield* run.pipe(Effect.forkChild);
    const second = yield* run.pipe(Effect.forkChild);
    const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)], {
      concurrency: "unbounded",
    });
    expect(results.filter(Result.isSuccess)).toHaveLength(1);
    expect(results.filter(Result.isFailure)).toHaveLength(1);
    expect(fixture.discoveryCalls).toBe(1);
  }),
);

it.effect("resumes an unattempted claim but stops an attempted search as ambiguous", () => {
  const resumable = makeFixture({ pendingAttemptCount: 0, pendingSequence: 0 });
  const ambiguous = makeFixture({ pendingAttemptCount: 1, pendingSequence: 0 });
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const collector = yield* ResearchCollector.Service;
      yield* collector.collect(report);
    }).pipe(Effect.provide(layer(resumable.port)));
    expect(resumable.discoveryCalls).toBe(1);

    const result = yield* Effect.gen(function* () {
      const collector = yield* ResearchCollector.Service;
      return yield* collector.collect(report);
    }).pipe(Effect.provide(layer(ambiguous.port)), Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "ResearchCollectorUnavailable",
        reason: "ambiguousOperation",
      });
    }
    expect(ambiguous.discoveryCalls).toBe(0);
    expect(ambiguous.operations.get(`${workflowId}:provider:0`)?.state).toBe("pending");
  });
});

it.effect(
  "expires a crashed provider attempt after its bounded lease without duplicate I/O",
  () => {
    const fixture = makeFixture({
      pendingAttemptCount: 1,
      pendingSequence: 0,
      pendingStartedAt: providerAttemptStartedAt,
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(providerAttemptExpiredAtMilliseconds);
      const collector = yield* ResearchCollector.Service;
      const result = yield* collector.collect(report).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(fixture.discoveryCalls).toBe(0);
      expect(fixture.operations.get(`${workflowId}:provider:0`)?.state).toBe("unknown");
      expect(fixture.failureCodes.get(`${workflowId}:provider:0`)).toBe(
        "expired-ambiguous-provider-attempt",
      );
    }).pipe(Effect.provide(layer(fixture.port)));
  },
);

it.effect("reconciles an attempted page from immutable R2 evidence without refetching", () => {
  const fixture = makeFixture({ pendingAttemptCount: 1, pendingSequence: 1, reconcilePage: true });
  return Effect.gen(function* () {
    const collector = yield* ResearchCollector.Service;
    const collection = yield* collector.collect(report);
    expect(collection.manifest.sources).toHaveLength(1);
    expect(fixture.pageFetchCalls).toBe(0);
    expect(fixture.operations.get(`${workflowId}:provider:1`)).toMatchObject({
      state: "completed",
      result: { _tag: "Page", contentKey: `users/${userId}/research/reconciled.json` },
    });
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("reconciles a late immutable page after the provider lease expired", () => {
  const fixture = makeFixture({
    pendingAttemptCount: 1,
    pendingSequence: 1,
    pendingState: "unknown",
    reconcilePage: true,
  });
  return Effect.gen(function* () {
    const collector = yield* ResearchCollector.Service;
    const collection = yield* collector.collect(report);
    expect(collection.manifest.sources).toHaveLength(1);
    expect(fixture.pageFetchCalls).toBe(0);
    expect(fixture.operations.get(`${workflowId}:provider:1`)?.state).toBe("completed");
  }).pipe(Effect.provide(layer(fixture.port)));
});

it.effect("removes uploaded page evidence when authority ends before PostgreSQL completion", () => {
  const fixture = makeFixture({ failAuthorizationAt: 4 });
  return Effect.gen(function* () {
    const collector = yield* ResearchCollector.Service;
    const result = yield* collector.collect(report).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(fixture.removedKeys).toEqual([`users/${userId}/research/source.json`]);
    expect(fixture.operations.get(`${workflowId}:provider:1`)?.state).toBe("canceled");
  }).pipe(Effect.provide(layer(fixture.port)));
});

const makeFixture = (
  options: {
    readonly pendingAttemptCount?: number;
    readonly pendingStartedAt?: Date;
    readonly pendingSequence?: number;
    readonly pendingState?: ResearchCollector.OperationState;
    readonly reconcilePage?: boolean;
    readonly ambiguousDiscoveryFailures?: number;
    readonly beforeClaimReturn?: () => Effect.Effect<void>;
    readonly failAuthorizationAt?: number;
    readonly duplicateUrlVariants?: boolean;
    readonly corruptManifestWorkflow?: boolean;
    readonly transientPageFailures?: number;
  } = {},
) => {
  const operations = new Map<string, ResearchCollector.Operation>();
  const failureCodes = new Map<string, string>();
  const evidenceBodies = new Array<string>();
  const removedKeys = new Array<string>();
  let retainedManifest: ResearchCollector.SourceManifest | null = null;
  let authorizationCalls = 0;
  let discoveryCalls = 0;
  let pageFetchCalls = 0;
  let ambiguousDiscoveryFailures = options.ambiguousDiscoveryFailures ?? 0;
  let transientPageFailures = options.transientPageFailures ?? 0;
  const port = ResearchCollector.Port.of({
    authorize: (current) =>
      Effect.gen(function* () {
        authorizationCalls += 1;
        if (authorizationCalls === options.failAuthorizationAt) {
          return yield* new ResearchReport.Unavailable({
            cause: "revoked",
            message: "Authority revoked",
            operation: "authorize",
          });
        }
        return current;
      }),
    persistence: {
      claim: (operation) =>
        Effect.gen(function* () {
          const retained = operations.get(operation.operationId);
          if (retained !== undefined) {
            yield* options.beforeClaimReturn?.() ?? Effect.void;
            return { _tag: "Existing" as const, operation: retained };
          }
          const pending =
            operation.sequence === options.pendingSequence
              ? {
                  ...operation,
                  attemptCount: options.pendingAttemptCount ?? 0,
                  startedAt: options.pendingStartedAt ?? null,
                  state: options.pendingState ?? operation.state,
                }
              : operation;
          operations.set(operation.operationId, pending);
          yield* options.beforeClaimReturn?.() ?? Effect.void;
          return operation.sequence === options.pendingSequence
            ? { _tag: "Existing" as const, operation: pending }
            : { _tag: "Created" as const, operation: pending };
        }),
      complete: (operation, result) =>
        Effect.sync(() => {
          const retained = operations.get(operation.operationId) ?? operation;
          const completed = { ...retained, result, state: "completed" as const };
          operations.set(operation.operationId, completed);
          return completed;
        }),
      finish: (operation, state, safeFailureCode) =>
        Effect.sync(() => {
          const retained = operations.get(operation.operationId) ?? operation;
          operations.set(operation.operationId, { ...retained, state });
          failureCodes.set(operation.operationId, safeFailureCode);
        }),
      expireAmbiguous: (operation, expiredBefore) =>
        Effect.sync(() => {
          if (
            operation.startedAt === null ||
            operation.startedAt.getTime() > expiredBefore.getTime()
          ) {
            return false;
          }
          const retained = operations.get(operation.operationId);
          if (
            retained === undefined ||
            retained.state !== "pending" ||
            retained.attemptCount !== operation.attemptCount
          ) {
            return false;
          }
          operations.set(operation.operationId, { ...retained, state: "unknown" });
          failureCodes.set(operation.operationId, "expired-ambiguous-provider-attempt");
          return true;
        }),
      recordAttempt: (operationId, expectedAttemptCount) =>
        Effect.sync(() => {
          const operation = operations.get(operationId);
          if (operation === undefined) {
            throw new Error("Provider operation missing");
          }
          if (operation.state !== "pending" || operation.attemptCount !== expectedAttemptCount) {
            return { _tag: "InFlight" as const, operation };
          }
          const started = {
            ...operation,
            attemptCount: operation.attemptCount + 1,
            startedAt: providerAttemptStartedAt,
          };
          operations.set(operationId, started);
          return { _tag: "Started" as const, operation: started };
        }),
    },
    provider: {
      discover: () =>
        Effect.suspend(() => {
          discoveryCalls += 1;
          if (ambiguousDiscoveryFailures > 0) {
            ambiguousDiscoveryFailures -= 1;
            return Effect.fail({ retry: "ambiguous" as const });
          }
          return Effect.succeed({
            evidence: { latencyMs: 1, requestId: "discovery-request" },
            results: [
              {
                description: "DISCOVERY_ONLY_TEXT",
                title: "Fetched source",
                url: "https://example.com/source",
              },
              ...(options.duplicateUrlVariants === true
                ? [
                    {
                      description: "SAME_PAGE_VARIANT",
                      title: "Fetched source variant",
                      url: "https://EXAMPLE.com:443/source#section",
                    },
                  ]
                : []),
            ],
          });
        }),
      fetchPage: () =>
        Effect.suspend(() => {
          pageFetchCalls += 1;
          if (transientPageFailures > 0) {
            transientPageFailures -= 1;
            return Effect.fail({ retry: "transient" as const });
          }
          return Effect.succeed(page());
        }),
    },
    sourceEvidence: {
      removeManifest: (_, removedWorkflowId) =>
        Effect.sync(() => {
          removedKeys.push(`manifest:${removedWorkflowId}`);
        }),
      removePage: (_, contentKey) =>
        Effect.sync(() => {
          removedKeys.push(contentKey);
        }),
      putManifest: (manifestUserId, manifest) =>
        Effect.sync(() => {
          retainedManifest = manifest;
          return {
            manifestDigest: ResearchReport.InputDigest.make("c".repeat(64)),
            manifestKey: `users/${manifestUserId}/research-report/manifests/${manifest.workflowId}.json`,
          };
        }),
      readManifest: (_, __, manifestDigest) =>
        retainedManifest !== null && manifestDigest === "c".repeat(64)
          ? Effect.succeed(
              options.corruptManifestWorkflow === true
                ? {
                    ...retainedManifest,
                    workflowId: ResearchReport.WorkflowId.make("another-workflow"),
                  }
                : retainedManifest,
            )
          : Effect.fail(
              new ResearchCollector.Unavailable({
                cause: "manifest",
                message: "manifest unavailable",
                reason: "storageUnavailable",
              }),
            ),
      put: (input) =>
        Effect.sync(() => {
          evidenceBodies.push(input.content);
          return pageResult(`users/${input.userId}/research/source.json`, input);
        }),
      reconcile: (reconciledUserId) =>
        Effect.succeed(
          options.reconcilePage === true
            ? pageResult(`users/${reconciledUserId}/research/reconciled.json`, {
                contentDigest: ResearchReport.InputDigest.make("b".repeat(64)),
                contentType: "text/plain",
                fetchedAt: new Date("2026-08-27T12:05:00.000Z"),
                finalUrl: "https://example.com/source",
                title: "Fetched source",
              })
            : null,
        ),
      readPage: (_, retainedPage) =>
        Effect.succeed(
          retainedPage.contentKey.includes("reconciled")
            ? "RECONCILED_BODY_TEXT"
            : "FETCHED_BODY_TEXT",
        ),
    },
  });
  return {
    evidenceBodies,
    failureCodes,
    operations,
    port,
    removedKeys,
    get discoveryCalls() {
      return discoveryCalls;
    },
    get pageFetchCalls() {
      return pageFetchCalls;
    },
  };
};

const page = () => ({
  content: "FETCHED_BODY_TEXT",
  contentType: "text/plain",
  fetchedBytes: 17n,
  finalUrl: "https://example.com/source",
  normalizedBytes: 17n,
  redirects: [],
  status: 200,
  title: "Fetched source",
});

const pageResult = (
  contentKey: string,
  input: {
    readonly contentDigest: ResearchReport.InputDigest;
    readonly contentType: string;
    readonly fetchedAt: Date;
    readonly finalUrl: string;
    readonly title: string | null;
  },
): Extract<ResearchCollector.OperationResult, { readonly _tag: "Page" }> => ({
  _tag: "Page",
  contentDigest: input.contentDigest,
  contentKey,
  contentType: input.contentType,
  fetchedAt: input.fetchedAt,
  finalUrl: input.finalUrl,
  title: input.title,
});

const layer = (port: ResearchCollector.PortInterface) =>
  ResearchCollector.layerWithoutDependencies.pipe(
    Layer.provide(Layer.succeed(ResearchCollector.Port, port)),
  );
