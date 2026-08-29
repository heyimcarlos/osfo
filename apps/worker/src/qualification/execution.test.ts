/* oxlint-disable eslint/no-underscore-dangle, vitest/no-standalone-expect -- Assertions inspect tagged exits inside Effect Vitest generators. */
import { expect, it } from "@effect/vitest";
import { Cause, DateTime, Effect, Exit, Ref } from "effect";

import {
  completeProductionEvidence,
  compactManifest,
  manifestVersions,
} from "../../test/support/qualification-fixtures";
import {
  createQualificationExecutionPlan,
  executeDurableQualification,
  executeQualification,
  qualificationExecutionReceiptForRun,
  qualificationRunArrivals,
  type QualificationExecutionDriver,
  type QualificationAuthorityCollectors,
  type QualificationExecutionArtifactStore,
  type QualificationExecutionPlan,
  type QualificationExecutionRun,
} from "./execution";
import {
  createBoundedBetaManifest,
  createScaleQualifiedPublicManifest,
} from "./qualification-manifest";
import { qualificationChecksum } from "./qualification-checksum";
import {
  qualificationExecutionEvidence,
  type QualificationRunExecutionReceipt,
} from "./production-qualification";

const requireDefined = <A>(value: A | undefined, message: string): Effect.Effect<A> =>
  value === undefined ? Effect.die(new Error(message)) : Effect.succeed(value);
const makePlan = (
  manifest: ReturnType<typeof compactManifest>,
  startsAtEpochMs: number,
  executionId = "execution-test",
) => createQualificationExecutionPlan(manifest, startsAtEpochMs, executionId);

const completeExecutionEvidence = (
  manifest: ReturnType<typeof compactManifest>,
  plan: QualificationExecutionPlan,
  runReceipts: ReadonlyArray<QualificationRunExecutionReceipt>,
) => {
  const evidence = completeProductionEvidence();
  const challengeRuns = evidence.runs.challengeRuns.map((run) => {
    const receipt = run.faultControllerReceipt;
    if (receipt === null) return run;
    const { artifactChecksum: _artifactChecksum, ...content } = {
      ...receipt,
      planChecksum: plan.planChecksum,
    };
    return Object.assign({}, run, {
      faultControllerReceipt: {
        ...content,
        artifactChecksum: qualificationChecksum(content),
      },
    });
  });
  return {
    ...evidence,
    execution: qualificationExecutionEvidence(
      manifest,
      plan.executionId,
      plan.planChecksum,
      "execution-test",
      runReceipts,
    ),
    runs: { ...evidence.runs, challengeRuns },
  };
};

const retainedRunReceipt = (
  plan: QualificationExecutionPlan,
  run: QualificationExecutionRun,
): QualificationRunExecutionReceipt =>
  qualificationExecutionReceiptForRun(
    plan,
    run,
    qualificationChecksum({ retainedArrivalRunId: run.runId }),
    `execution-receipt-${run.runId}`,
  );

const retainRun =
  (plan: QualificationExecutionPlan) =>
  (_manifest: ReturnType<typeof compactManifest>, run: QualificationExecutionRun) =>
    Effect.succeed(retainedRunReceipt(plan, run));

const collectComplete =
  (manifest: ReturnType<typeof compactManifest>) =>
  (
    _manifest: ReturnType<typeof compactManifest>,
    plan: QualificationExecutionPlan,
    receipts: ReadonlyArray<QualificationRunExecutionReceipt>,
  ) =>
    Effect.succeed(completeExecutionEvidence(manifest, plan, receipts));

const authorityCollectors = (
  manifest: ReturnType<typeof compactManifest>,
  plan: QualificationExecutionPlan,
): QualificationAuthorityCollectors<never> => {
  const evidence = completeExecutionEvidence(manifest, plan, []);
  return {
    cost: () => Effect.succeed(evidence.cost),
    externalGates: () => Effect.succeed(evidence.externalGates),
    memorySemantic: () => Effect.succeed(evidence.memorySemantic),
    recoveryRuns: () => Effect.succeed(evidence.recoveryRuns),
    resourceUse: () => Effect.succeed(evidence.resourceUse),
    runs: () => Effect.succeed(evidence.runs),
    semantic: () => Effect.succeed(evidence.semantic),
    stages: () => Effect.succeed(evidence.stages),
  };
};

const memoryArtifactStore = (omitOnRead: (artifactId: string) => boolean = () => false) => {
  const retained = new Map<string, string>();
  const store = {
    read: (artifactId: string) =>
      Effect.succeed(omitOnRead(artifactId) ? null : (retained.get(artifactId) ?? null)),
    writeImmutable: (artifactId: string, encoded: string) =>
      Effect.sync(() => {
        const existing = retained.get(artifactId);
        if (existing !== undefined && existing !== encoded)
          throw new Error("immutable artifact conflict");
        retained.set(artifactId, encoded);
      }),
  } satisfies QualificationExecutionArtifactStore<never>;
  return {
    retained,
    store,
  };
};

it.effect("builds and executes the frozen open-arrival and fault plan before qualification", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = makePlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const executed = yield* Ref.make<ReadonlyArray<string>>([]);
    const driver: QualificationExecutionDriver<never> = {
      collectEvidence: collectComplete(manifest),
      executeRun: (_manifest, run) =>
        Ref.update(executed, (ids) => [...ids, run.runId]).pipe(
          Effect.as(retainedRunReceipt(plan, run)),
        ),
      prepare: () => Ref.update(executed, (ids) => [...ids, "prepare"]),
      teardown: () => Ref.update(executed, (ids) => [...ids, "teardown"]),
      verifyRun: () => Effect.void,
    };

    const report = yield* executeQualification({ driver, manifest, plan });
    const executionOrder = yield* Ref.get(executed);

    expect(plan.manifestChecksum).toBe(manifest.manifestChecksum);
    expect(plan.runs.some((run) => run.kind === "challenge" && run.fault !== null)).toBe(true);
    expect(plan.runs.some((run) => run.kind === "characterization")).toBe(true);
    expect(plan.runs.every((run) => run.arrivalCount > 0)).toBe(true);
    const firstRun = yield* requireDefined(plan.runs.at(0), "plan contains no runs");
    expect(Array.from(qualificationRunArrivals(manifest, firstRun))).toHaveLength(
      firstRun.arrivalCount,
    );
    expect(executionOrder).toEqual(["prepare", ...plan.runs.map(({ runId }) => runId), "teardown"]);
    expect(report.verdict).toBe("PASS");
  }),
);

it.effect(
  "durably retains, reloads, and verifies every canonical arrival before PASS",
  () =>
    Effect.gen(function* () {
      const manifest = compactManifest();
      const plan = makePlan(
        manifest,
        Date.parse("2026-08-17T12:00:00.000Z"),
        "durable-execution-test",
      );
      const { retained, store } = memoryArtifactStore();
      const executedRoots = new Set<string>();
      let executedCount = 0;
      const report = yield* executeDurableQualification({
        manifest,
        plan,
        ports: {
          artifacts: store,
          authorities: authorityCollectors(manifest, plan),
          executeArrival: (_manifest, _run, arrival) =>
            Effect.sync(() => {
              executedCount += 1;
              executedRoots.add(arrival.rootId);
              return {
                authorityFactId: `accepted-${arrival.rootId}`,
                executedAtUtc: DateTime.formatIso(DateTime.makeUnsafe(arrival.offeredAtEpochMs)),
                rootId: arrival.rootId,
              };
            }),
          prepare: () => Effect.void,
          teardown: () => Effect.void,
        },
      });
      expect(report.verdict).toBe("PASS");
      expect(executedCount).toBe(plan.runs.reduce((count, run) => count + run.arrivalCount, 0));
      expect(executedRoots.size).toBe(executedCount);
      expect(retained.has("qualification/executions/durable-execution-test/plan.json")).toBe(true);
      expect(
        retained.has("qualification/executions/durable-execution-test/authority-bundle.json"),
      ).toBe(true);
    }),
  15_000,
);

it.effect("rejects missing retained arrivals instead of evaluating self-attested evidence", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = makePlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"), "missing-arrival-test");
    const { store } = memoryArtifactStore((artifactId) => artifactId.includes("arrivals-0.json"));
    const result = yield* Effect.flip(
      executeDurableQualification({
        manifest,
        plan,
        ports: {
          artifacts: store,
          authorities: authorityCollectors(manifest, plan),
          executeArrival: (_manifest, _run, arrival) =>
            Effect.succeed({
              authorityFactId: `accepted-${arrival.rootId}`,
              executedAtUtc: DateTime.formatIso(DateTime.makeUnsafe(arrival.offeredAtEpochMs)),
              rootId: arrival.rootId,
            }),
          prepare: () => Effect.void,
          teardown: () => Effect.void,
        },
      }),
    );

    expect(result._tag).toBe("QualificationExecutionInvalid");
  }),
);

it("keeps real beta and public plans compact with exact deterministic cardinality", () => {
  const startsAt = Date.parse("2026-08-17T12:00:00.000Z");
  const beta = createQualificationExecutionPlan(
    createBoundedBetaManifest(manifestVersions),
    startsAt,
    "beta-plan",
  );
  const publicPlan = createQualificationExecutionPlan(
    createScaleQualifiedPublicManifest(manifestVersions),
    startsAt,
    "public-plan",
  );

  expect(beta.runs.reduce((total, run) => total + run.arrivalCount, 0)).toBe(150_274);
  expect(publicPlan.runs.reduce((total, run) => total + run.arrivalCount, 0)).toBe(1_750_422);
  expect(beta.runs).toHaveLength(32);
  expect(publicPlan.runs).toHaveLength(96);
  expect(JSON.stringify(publicPlan).length).toBeLessThan(200_000);
  expect(publicPlan.runs.every((run) => !("arrivals" in run))).toBe(true);
  expect(
    createQualificationExecutionPlan(
      createScaleQualifiedPublicManifest(manifestVersions),
      startsAt,
      "public-plan",
    ).planChecksum,
  ).toBe(publicPlan.planChecksum);
});

it.effect("tears down after an execution failure without manufacturing a verdict", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = makePlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const tornDown = yield* Ref.make(false);
    const driver: QualificationExecutionDriver<"injected"> = {
      collectEvidence: () => Effect.die(new Error("collect must not run")),
      executeRun: () => Effect.fail("injected"),
      prepare: () => Effect.void,
      teardown: () => Ref.set(tornDown, true),
      verifyRun: () => Effect.void,
    };

    expect(yield* Effect.flip(executeQualification({ driver, manifest, plan }))).toBe("injected");
    expect(yield* Ref.get(tornDown)).toBe(true);
  }),
);

it.effect("tears down after prepare and collection failures", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = makePlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    for (const failurePoint of ["prepare", "collect"] as const) {
      const tornDown = yield* Ref.make(false);
      const driver: QualificationExecutionDriver<"injected"> = {
        collectEvidence: (_manifest, _plan, receipts) =>
          failurePoint === "collect"
            ? Effect.fail("injected")
            : Effect.succeed(completeExecutionEvidence(manifest, plan, receipts)),
        executeRun: retainRun(plan),
        prepare: () => (failurePoint === "prepare" ? Effect.fail("injected") : Effect.void),
        teardown: () => Ref.set(tornDown, true),
        verifyRun: () => Effect.void,
      };

      expect(yield* Effect.flip(executeQualification({ driver, manifest, plan }))).toBe("injected");
      expect(yield* Ref.get(tornDown)).toBe(true);
    }
  }),
);

it.effect("surfaces teardown failure instead of returning a qualification verdict", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = makePlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const driver: QualificationExecutionDriver<"teardown"> = {
      collectEvidence: collectComplete(manifest),
      executeRun: retainRun(plan),
      prepare: () => Effect.void,
      teardown: () => Effect.fail("teardown"),
      verifyRun: () => Effect.void,
    };

    expect(yield* Effect.flip(executeQualification({ driver, manifest, plan }))).toBe("teardown");
  }),
);

it.effect("retains both execution and teardown failures in the typed cause", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = makePlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const driver: QualificationExecutionDriver<"execution" | "teardown"> = {
      collectEvidence: () => Effect.die(new Error("collect must not run")),
      executeRun: () => Effect.fail("execution"),
      prepare: () => Effect.void,
      teardown: () => Effect.fail("teardown"),
      verifyRun: () => Effect.void,
    };

    const exit = yield* Effect.exit(executeQualification({ driver, manifest, plan }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.filter(Cause.isFailReason).map(({ error }) => error)).toEqual(
        expect.arrayContaining(["execution", "teardown"]),
      );
    }
  }),
);

it.effect("rejects mismatched plan and collected source or topology versions", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = makePlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const mismatchedPlan = { ...plan, sourceVersion: "other-source" };
    const notPrepared = yield* Ref.make(true);
    const planDriver: QualificationExecutionDriver<never> = {
      collectEvidence: collectComplete(manifest),
      executeRun: retainRun(plan),
      prepare: () => Ref.set(notPrepared, false),
      teardown: () => Effect.void,
      verifyRun: () => Effect.void,
    };

    const planFailure = yield* Effect.flip(
      executeQualification({ driver: planDriver, manifest, plan: mismatchedPlan }),
    );
    expect(planFailure._tag).toBe("QualificationExecutionInvalid");
    expect(yield* Ref.get(notPrepared)).toBe(true);

    for (const mismatch of ["source", "topology"] as const) {
      const tornDown = yield* Ref.make(false);
      const driver: QualificationExecutionDriver<never> = {
        collectEvidence: (_manifest, _plan, receipts) => {
          const evidence = completeExecutionEvidence(manifest, plan, receipts);
          return Effect.succeed({
            ...evidence,
            manifest: {
              ...evidence.manifest,
              sourceVersion:
                mismatch === "source" ? "other-source" : evidence.manifest.sourceVersion,
              topologyVersion:
                mismatch === "topology" ? "other-topology" : evidence.manifest.topologyVersion,
            },
          });
        },
        executeRun: retainRun(plan),
        prepare: () => Effect.void,
        teardown: () => Ref.set(tornDown, true),
        verifyRun: () => Effect.void,
      };

      const evidenceFailure = yield* Effect.flip(executeQualification({ driver, manifest, plan }));
      expect(evidenceFailure._tag).toBe("QualificationExecutionInvalid");
      expect(yield* Ref.get(tornDown)).toBe(true);
    }
  }),
);

it.effect("rejects evidence retained for a different execution plan", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = makePlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const otherPlan = createQualificationExecutionPlan(
      manifest,
      Date.parse("2026-08-18T12:00:00.000Z"),
      "other-execution",
    );
    const tornDown = yield* Ref.make(false);
    const driver: QualificationExecutionDriver<never> = {
      collectEvidence: (_manifest, _plan, receipts) =>
        Effect.succeed(completeExecutionEvidence(manifest, otherPlan, receipts)),
      executeRun: retainRun(plan),
      prepare: () => Effect.void,
      teardown: () => Ref.set(tornDown, true),
      verifyRun: () => Effect.void,
    };

    const failure = yield* Effect.flip(executeQualification({ driver, manifest, plan }));
    expect(failure._tag).toBe("QualificationExecutionInvalid");
    expect(yield* Ref.get(tornDown)).toBe(true);
  }),
);

it.effect("rejects a collector that does not retain every driver-produced run receipt", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = makePlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const driver: QualificationExecutionDriver<never> = {
      collectEvidence: () => Effect.succeed(completeExecutionEvidence(manifest, plan, [])),
      executeRun: retainRun(plan),
      prepare: () => Effect.void,
      teardown: () => Effect.void,
      verifyRun: () => Effect.void,
    };

    expect((yield* Effect.flip(executeQualification({ driver, manifest, plan })))._tag).toBe(
      "QualificationExecutionInvalid",
    );
  }),
);

it.effect("rejects a self-consistent plan that omits the frozen workload", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = makePlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const { planChecksum: _planChecksum, ...content } = { ...plan, runs: [] };
    const incompletePlan = { ...content, planChecksum: qualificationChecksum(content) };
    const driver: QualificationExecutionDriver<never> = {
      collectEvidence: collectComplete(manifest),
      executeRun: retainRun(plan),
      prepare: () => Effect.die(new Error("invalid plan must not prepare")),
      teardown: () => Effect.void,
      verifyRun: () => Effect.void,
    };

    expect(
      (yield* Effect.flip(executeQualification({ driver, manifest, plan: incompletePlan })))._tag,
    ).toBe("QualificationExecutionInvalid");
  }),
);

it.effect("cannot turn telemetry-only records into PASS", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = makePlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const driver: QualificationExecutionDriver<never> = {
      collectEvidence: (_manifest, _plan, receipts) => {
        const evidence = completeExecutionEvidence(manifest, plan, receipts);
        return Effect.succeed({
          ...evidence,
          semantic: {
            ...evidence.semantic,
            localEvidence: [],
            productAuthorityExports: [],
            telemetry: evidence.semantic.acceptedRootIds.map((rootId) => ({
              observedAt: "2026-08-17T12:00:00.100Z",
              rootId,
              signal: "qualification.telemetry.observed",
              store: "AgentSQLite" as const,
            })),
          },
        });
      },
      executeRun: retainRun(plan),
      prepare: () => Effect.void,
      teardown: () => Effect.void,
      verifyRun: () => Effect.void,
    };

    expect((yield* executeQualification({ driver, manifest, plan })).verdict).toBe("MISSING");
  }),
);
