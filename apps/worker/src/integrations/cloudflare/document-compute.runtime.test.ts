/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, vitest/no-standalone-expect -- Promise fakes model external adapters; fixed lease time and assertions stay inside the Effect test. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import {
  DocumentIntentDigest,
  DocumentSource,
  type CostEvidence,
} from "../../services/document-generation";
import {
  makeWithSandbox,
  sandboxIdFor,
  type ActiveAttemptEvidence,
  type AttemptEvidenceStore,
  type SandboxClient,
} from "./document-compute";

it("derives distinct Sandbox-safe identities for long document content IDs", () => {
  const first = sandboxIdFor(ContentId.make(`document:workflow:research:${"a".repeat(64)}`));
  const second = sandboxIdFor(ContentId.make(`document:workflow:research:${"b".repeat(64)}`));

  expect(first).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u);
  expect(first).toHaveLength(63);
  expect(second).not.toBe(first);
});

it.effect("rechecks protected-effect authority before every attempt-evidence R2 mutation", () => {
  const events: Array<string> = [];
  let authorizationChecks = 0;
  const allowancePeriodId = AllowancePeriodId.make("allowance-1");
  const contentId = ContentId.make("document:toolCall:tool-1");
  const intentDigest = DocumentIntentDigest.make("a".repeat(64));
  const cost: Extract<CostEvidence, { _tag: "Incurred" }> = {
    _tag: "Incurred",
    allowancePeriodId,
    basis: "conservative",
    providerOperationId: "provider-operation-1",
    usdMicros: 50_000n,
  };
  const evidence = {
    cost,
    executionLeaseExpiresAt: Date.now() + 10 * 60_000,
    intentDigest,
    renderedPageCount: null,
    status: "claimed" as const,
    userId: UserId.make("user-1"),
  };
  const attempts: AttemptEvidenceStore = {
    claim: async () => {
      events.push("claim");
      return { _tag: "Claimed", created: true, evidence, revision: "revision-1" };
    },
    complete: async () => {
      events.push("complete");
      return true;
    },
    inspect: async () => null,
    reclaim: async () => null,
    start: async () => {
      events.push("start");
      return "revision-2";
    },
  };
  const sandbox: SandboxClient = {
    destroy: async () => undefined,
    exec: async () => ({ exitCode: 0, stdout: '{"renderedPageCount":1}', success: true }),
    exists: async () => ({ exists: false }),
    readStream: async () => ({ content: new ReadableStream<Uint8Array>(), size: 0 }),
    readText: async () => "",
    writeFile: async () => undefined,
  };
  const compute = makeWithSandbox(() => sandbox, attempts, 50_000n);

  return compute
    .generate({
      allowancePeriodId,
      authorizeWrite: Effect.suspend(() => {
        authorizationChecks += 1;
        events.push(`authorize:${authorizationChecks}`);
        return authorizationChecks < 3
          ? Effect.void
          : Effect.fail({
              _tag: "Denied" as const,
              reason: "authorityRevoked" as const,
              resetAt: null,
            });
      }),
      contentId,
      format: "pdf",
      intentDigest,
      source: DocumentSource.make({ pages: [{ lines: ["hello"], title: "Title" }] }),
      supportingVisuals: [],
      userId: UserId.make("user-1"),
    })
    .pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toMatchObject({
            _tag: "AuthorizationFailure",
            cost: { _tag: "Incurred" },
            failure: { _tag: "Denied", reason: "authorityRevoked" },
          });
          expect(events).toEqual(["authorize:1", "claim", "authorize:2", "start", "authorize:3"]);
          expect(events).not.toContain("complete");
        }),
      ),
    );
});

it.effect("reports proven no use when authority ends before the atomic start transition", () => {
  const events: Array<string> = [];
  let authorizationChecks = 0;
  const evidence = attemptEvidence({
    executionLeaseExpiresAt: Number.MAX_SAFE_INTEGER,
    status: "claimed",
  });
  const attempts: AttemptEvidenceStore = {
    claim: async () => {
      events.push("claim");
      return { _tag: "Claimed", created: true, evidence, revision: "revision-1" };
    },
    complete: async () => true,
    inspect: async () => null,
    reclaim: async () => null,
    start: async () => {
      events.push("start");
      return "revision-2";
    },
  };
  let providerExecutions = 0;
  const sandbox: SandboxClient = {
    destroy: async () => undefined,
    exec: async () => {
      providerExecutions += 1;
      return { exitCode: 0, stdout: '{"renderedPageCount":1}', success: true };
    },
    exists: async () => ({ exists: false }),
    readStream: async () => ({ content: new ReadableStream<Uint8Array>(), size: 0 }),
    readText: async () => "",
    writeFile: async () => undefined,
  };
  const compute = makeWithSandbox(() => sandbox, attempts, 50_000n);

  return compute
    .generate({
      allowancePeriodId: testAllowancePeriodId,
      authorizeWrite: Effect.suspend(() => {
        authorizationChecks += 1;
        return authorizationChecks === 1
          ? Effect.void
          : Effect.fail({
              _tag: "Denied" as const,
              reason: "authorityRevoked" as const,
              resetAt: null,
            });
      }),
      contentId: testContentId,
      format: "pdf",
      intentDigest: testIntentDigest,
      source: DocumentSource.make({ pages: [{ lines: ["hello"], title: "Title" }] }),
      supportingVisuals: [],
      userId: testUserId,
    })
    .pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toMatchObject({
            _tag: "AuthorizationFailure",
            cost: { _tag: "ProvenNoUse" },
          });
          expect(events).toEqual(["claim"]);
          expect(providerExecutions).toBe(0);
        }),
      ),
    );
});

it.effect("keeps a live started lease pending without another provider execution", () => {
  const fixture = recoveryFixture(
    attemptEvidence({ executionLeaseExpiresAt: Number.MAX_SAFE_INTEGER, status: "started" }),
  );
  return Effect.gen(function* () {
    expect(yield* fixture.generate()).toMatchObject({ _tag: "AttemptPending" });
    expect(fixture.execCalls()).toBe(0);
  });
});

it.effect("recovers cached output for an expired started lease without a second operation", () => {
  const fixture = recoveryFixture(
    attemptEvidence({ executionLeaseExpiresAt: -1, status: "started" }),
    { outputExists: true },
  );
  return Effect.gen(function* () {
    expect(yield* fixture.generate()).toMatchObject({
      _tag: "Completed",
      cost: { providerOperationId: "provider-operation-1" },
      renderedPageCount: 1,
    });
    expect(fixture.execCalls()).toBe(0);
    expect(fixture.evidence()?.status).toBe("completed");
  });
});

it.effect("reclaims a missing expired output and reports interruption before safe retry", () => {
  const fixture = recoveryFixture(
    attemptEvidence({ executionLeaseExpiresAt: -1, status: "started" }),
  );
  return Effect.gen(function* () {
    expect(yield* fixture.generate()).toMatchObject({
      _tag: "Interrupted",
      cost: { providerOperationId: "provider-operation-1" },
    });
    expect(fixture.evidence()).toMatchObject({
      cost: { providerOperationId: "provider-operation-1" },
      status: "claimed",
    });
    expect(fixture.execCalls()).toBe(0);
  });
});

it.effect("classifies an expired-lease CAS loser as pending", () => {
  const fixture = recoveryFixture(
    attemptEvidence({ executionLeaseExpiresAt: -1, status: "started" }),
    { reclaimLoses: true },
  );
  return Effect.gen(function* () {
    expect(yield* fixture.generate()).toMatchObject({ _tag: "AttemptPending" });
    expect(fixture.evidence()?.status).toBe("started");
    expect(fixture.execCalls()).toBe(0);
  });
});

it.effect(
  "recovers a transient completion write from cached output with one provider operation",
  () => {
    const fixture = recoveryFixture(null, { completeFailures: 1 });
    return Effect.gen(function* () {
      expect(yield* fixture.generate()).toMatchObject({ _tag: "Interrupted" });
      expect(fixture.evidence()?.status).toBe("started");
      fixture.expireLease();

      expect(yield* fixture.generate()).toMatchObject({
        _tag: "Completed",
        cost: { providerOperationId: fixture.providerOperationId() },
      });
      expect(fixture.execCalls()).toBe(1);
      expect(fixture.evidence()?.status).toBe("completed");
    });
  },
);

it.effect("does not overwrite cached completion evidence after losing its CAS", () => {
  const fixture = recoveryFixture(
    attemptEvidence({ executionLeaseExpiresAt: -1, status: "started" }),
    { completeLoses: true, outputExists: true },
  );
  return Effect.gen(function* () {
    expect(yield* fixture.generate()).toMatchObject({ _tag: "AttemptPending" });
    expect(fixture.evidence()?.status).toBe("started");
    expect(fixture.execCalls()).toBe(0);
  });
});

const testAllowancePeriodId = AllowancePeriodId.make("allowance-1");
const testContentId = ContentId.make("document:workflow:test-recovery");
const testIntentDigest = DocumentIntentDigest.make("a".repeat(64));
const testUserId = UserId.make("user-1");

const attemptEvidence = (
  input: Pick<ActiveAttemptEvidence, "executionLeaseExpiresAt" | "status">,
): ActiveAttemptEvidence => ({
  cost: {
    _tag: "Incurred",
    allowancePeriodId: testAllowancePeriodId,
    basis: "conservative",
    providerOperationId: "provider-operation-1",
    usdMicros: 50_000n,
  },
  executionLeaseExpiresAt: input.executionLeaseExpiresAt,
  intentDigest: testIntentDigest,
  renderedPageCount: input.status === "completed" ? 1 : null,
  status: input.status,
  userId: testUserId,
});

const recoveryFixture = (
  initialEvidence: ActiveAttemptEvidence | null,
  options: {
    readonly completeFailures?: number;
    readonly completeLoses?: boolean;
    readonly outputExists?: boolean;
    readonly reclaimLoses?: boolean;
  } = {},
) => {
  let evidence = initialEvidence;
  let revision = "revision-1";
  let completeFailures = options.completeFailures ?? 0;
  let execCalls = 0;
  let providerOperationId = initialEvidence?.cost.providerOperationId ?? "";
  let outputExists = options.outputExists ?? false;
  const attempts: AttemptEvidenceStore = {
    claim: async (_contentId, intentDigest, cost, executionLeaseExpiresAt, userId) => {
      if (evidence === null) {
        providerOperationId = cost.providerOperationId;
        evidence = {
          cost,
          executionLeaseExpiresAt,
          intentDigest,
          renderedPageCount: null,
          status: "claimed",
          userId,
        };
        return { _tag: "Claimed", created: true, evidence, revision };
      }
      return { _tag: "Claimed", created: false, evidence, revision };
    },
    complete: async (_contentId, completed) => {
      if (completeFailures > 0) {
        completeFailures -= 1;
        throw new Error("completion acknowledgement unavailable");
      }
      if (options.completeLoses === true) return false;
      evidence = completed;
      revision = "revision-completed";
      return true;
    },
    inspect: async () => evidence,
    reclaim: async (_contentId, reclaimed) => {
      if (options.reclaimLoses === true) return null;
      evidence = reclaimed;
      revision = "revision-reclaimed";
      return revision;
    },
    start: async (_contentId, started) => {
      evidence = started;
      revision = "revision-started";
      return revision;
    },
  };
  const sandbox: SandboxClient = {
    destroy: async () => undefined,
    exec: async () => {
      execCalls += 1;
      outputExists = true;
      return { exitCode: 0, stdout: '{"renderedPageCount":1}', success: true };
    },
    exists: async () => ({ exists: outputExists }),
    readStream: async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      return {
        content: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        size: bytes.byteLength,
      };
    },
    readText: async () => "",
    writeFile: async () => undefined,
  };
  const compute = makeWithSandbox(() => sandbox, attempts, 50_000n);
  return {
    evidence: () => evidence,
    expireLease: () => {
      if (evidence !== null) evidence = { ...evidence, executionLeaseExpiresAt: -1 };
    },
    execCalls: () => execCalls,
    generate: () =>
      compute.generate({
        allowancePeriodId: testAllowancePeriodId,
        authorizeWrite: Effect.void,
        contentId: testContentId,
        format: "pdf",
        intentDigest: testIntentDigest,
        source: DocumentSource.make({ pages: [{ lines: ["hello"], title: "Title" }] }),
        supportingVisuals: [],
        userId: testUserId,
      }),
    providerOperationId: () => providerOperationId,
  };
};
