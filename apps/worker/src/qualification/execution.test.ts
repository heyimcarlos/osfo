/* oxlint-disable eslint/no-underscore-dangle, vitest/no-standalone-expect -- Assertions inspect tagged exits inside Effect Vitest generators. */
import { expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import {
  completeProductionEvidence,
  compactManifest,
} from "../../test/support/qualification-fixtures";
import {
  createQualificationExecutionPlan,
  executeQualification,
  type QualificationExecutionDriver,
} from "./execution";

it.effect("builds and executes the frozen open-arrival and fault plan before qualification", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const executed = yield* Ref.make<ReadonlyArray<string>>([]);
    const driver: QualificationExecutionDriver<never> = {
      collectEvidence: () => Effect.succeed(completeProductionEvidence()),
      executeRun: (run) => Ref.update(executed, (ids) => [...ids, run.runId]),
      prepare: () => Ref.update(executed, (ids) => [...ids, "prepare"]),
      teardown: () => Ref.update(executed, (ids) => [...ids, "teardown"]),
    };

    const report = yield* executeQualification({ driver, manifest, plan });
    const executionOrder = yield* Ref.get(executed);

    expect(plan.manifestChecksum).toBe(manifest.manifestChecksum);
    expect(plan.runs.some((run) => run.kind === "challenge" && run.fault !== null)).toBe(true);
    expect(plan.runs.some((run) => run.kind === "characterization")).toBe(true);
    expect(plan.runs.every((run) => run.arrivals.length > 0)).toBe(true);
    expect(executionOrder).toEqual(["prepare", ...plan.runs.map(({ runId }) => runId), "teardown"]);
    expect(report.verdict).toBe("PASS");
  }),
);

it.effect("tears down after an execution failure without manufacturing a verdict", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const tornDown = yield* Ref.make(false);
    const driver: QualificationExecutionDriver<"injected"> = {
      collectEvidence: () => Effect.die(new Error("collect must not run")),
      executeRun: () => Effect.fail("injected"),
      prepare: () => Effect.void,
      teardown: () => Ref.set(tornDown, true),
    };

    expect(yield* Effect.flip(executeQualification({ driver, manifest, plan }))).toBe("injected");
    expect(yield* Ref.get(tornDown)).toBe(true);
  }),
);

it.effect("tears down after prepare and collection failures", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    for (const failurePoint of ["prepare", "collect"] as const) {
      const tornDown = yield* Ref.make(false);
      const driver: QualificationExecutionDriver<"injected"> = {
        collectEvidence: () =>
          failurePoint === "collect"
            ? Effect.fail("injected")
            : Effect.succeed(completeProductionEvidence()),
        executeRun: () => Effect.void,
        prepare: () => (failurePoint === "prepare" ? Effect.fail("injected") : Effect.void),
        teardown: () => Ref.set(tornDown, true),
      };

      expect(yield* Effect.flip(executeQualification({ driver, manifest, plan }))).toBe("injected");
      expect(yield* Ref.get(tornDown)).toBe(true);
    }
  }),
);

it.effect("surfaces teardown failure instead of returning a qualification verdict", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const driver: QualificationExecutionDriver<never> = {
      collectEvidence: () => Effect.succeed(completeProductionEvidence()),
      executeRun: () => Effect.void,
      prepare: () => Effect.void,
      teardown: () => Effect.die(new Error("teardown failed")),
    };

    const exit = yield* Effect.exit(executeQualification({ driver, manifest, plan }));
    expect(exit._tag).toBe("Failure");
  }),
);

it.effect("rejects mismatched plan and collected source or topology versions", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const mismatchedPlan = { ...plan, sourceVersion: "other-source" };
    const notPrepared = yield* Ref.make(true);
    const planDriver: QualificationExecutionDriver<never> = {
      collectEvidence: () => Effect.succeed(completeProductionEvidence()),
      executeRun: () => Effect.void,
      prepare: () => Ref.set(notPrepared, false),
      teardown: () => Effect.void,
    };

    const planFailure = yield* Effect.flip(
      executeQualification({ driver: planDriver, manifest, plan: mismatchedPlan }),
    );
    expect(planFailure._tag).toBe("QualificationExecutionInvalid");
    expect(yield* Ref.get(notPrepared)).toBe(true);

    for (const mismatch of ["source", "topology"] as const) {
      const tornDown = yield* Ref.make(false);
      const evidence = completeProductionEvidence();
      const driver: QualificationExecutionDriver<never> = {
        collectEvidence: () =>
          Effect.succeed({
            ...evidence,
            manifest: {
              ...evidence.manifest,
              sourceVersion:
                mismatch === "source" ? "other-source" : evidence.manifest.sourceVersion,
              topologyVersion:
                mismatch === "topology" ? "other-topology" : evidence.manifest.topologyVersion,
            },
          }),
        executeRun: () => Effect.void,
        prepare: () => Effect.void,
        teardown: () => Ref.set(tornDown, true),
      };

      const evidenceFailure = yield* Effect.flip(executeQualification({ driver, manifest, plan }));
      expect(evidenceFailure._tag).toBe("QualificationExecutionInvalid");
      expect(yield* Ref.get(tornDown)).toBe(true);
    }
  }),
);

it.effect("cannot turn telemetry-only records into PASS", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, Date.parse("2026-08-17T12:00:00.000Z"));
    const evidence = completeProductionEvidence();
    const driver: QualificationExecutionDriver<never> = {
      collectEvidence: () =>
        Effect.succeed({
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
        }),
      executeRun: () => Effect.void,
      prepare: () => Effect.void,
      teardown: () => Effect.void,
    };

    expect((yield* executeQualification({ driver, manifest, plan })).verdict).toBe("MISSING");
  }),
);
