/* oxlint-disable vitest/no-standalone-expect, eslint/no-underscore-dangle -- Effect Vitest executes generator assertions inside each test, and tagged unions use _tag. */
/* oxlint-disable typescript/no-misused-spread -- Test fixtures copy decoded immutable schema values intentionally. */

import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import { AssistantMessageId, UserId } from "../../domain";
import {
  PersonalSkillId,
  PersonalSkillVersion,
  PersonalSkillVersionId,
  SkillLearningCandidateId,
  type SkillLearningCandidate,
} from "../../domain/personal-skill";
import { makeSkillLearningCoordinator, type SkillLearningLoad } from "./skill-learning-coordinator";
import { PersonalSkillConflict } from "./personal-skill-authority";
import { makeSkillLearningAdmission } from "./skill-learning-admission";

const userId = UserId.make("user-1");
const candidate: SkillLearningCandidate = {
  availableCapabilityIds: ["document-generation"],
  availableRequirements: ["document-renderer"],
  candidateBytes: 200n,
  candidateId: SkillLearningCandidateId.make("candidate-1"),
  corrections: ["Put the summary first."],
  createdAtEpochMillis: 1_788_000_000_000,
  decisions: ["Keep weekly reports under five pages."],
  evidence: [
    { _tag: "ExplicitUserCorrection", referenceId: "correction-1" },
    { _tag: "ConfirmedRootOutcome", referenceId: "turn-1" },
  ],
  ownerUserId: userId,
  priorSkillId: null,
  priorSkillVersion: null,
  rootAssistantMessageId: AssistantMessageId.make("assistant-1"),
  rootOutcomeReferenceId: "turn-1",
  taskDescription: "Create the weekly status report as a PDF.",
};
const load: SkillLearningLoad = {
  concurrentJobsForUser: 0,
  concurrentJobsGlobally: 0,
  jobsInRollingDay: 0,
  retainedSkillHistoryBytes: 0n,
  retainedSkills: 0,
};
const availability = {
  capabilityIds: ["document-generation"],
  requirements: ["document-renderer"],
} as const;

describe("SkillLearningCoordinator", () => {
  it.effect("shares one atomic Worker admission fence across coordinator runs", () =>
    Effect.gen(function* () {
      const admission = makeSkillLearningAdmission(1);
      const first = yield* admission.acquire;
      expect(Option.isSome(first)).toBe(true);
      expect(Option.isNone(yield* admission.acquire)).toBe(true);
      if (Option.isNone(first)) return;
      yield* first.value;
      expect(Option.isSome(yield* admission.acquire)).toBe(true);
    }),
  );

  it.effect("does not learn from a straightforward root outcome without reusable evidence", () =>
    Effect.gen(function* () {
      let proposed = false;
      const coordinator = makeSkillLearningCoordinator({
        authority: unusedAuthority(),
        propose: () => {
          proposed = true;
          return Effect.die(new Error("unexpected proposal"));
        },
        recordCompanyCost: () => Effect.void,
      });
      const outcome = yield* coordinator.run({
        availability,
        candidate: null,
        load,
        nowEpochMillis: 1_788_000_000_100,
      });
      expect(outcome).toEqual({ _tag: "NoLearning", reason: "noReusableLearning" });
      expect(proposed).toBe(false);
    }),
  );

  it.effect(
    "creates a safe Skill after commit, records company cost, and reports material undo",
    () =>
      Effect.gen(function* () {
        const settled: Array<string> = [];
        const costs: Array<number> = [];
        const created: Array<string> = [];
        const authority = fakeAuthority({ created, settled });
        const coordinator = makeSkillLearningCoordinator({
          authority,
          propose: ({ candidate: input, priorVersion }) => {
            expect(input).toEqual(candidate);
            expect(priorVersion).toBeNull();
            return Effect.succeed({
              proposal: {
                _tag: "Change",
                evidence: "explicitConfirmation",
                materiality: "material",
                skillsChanged: 1,
                version: skillVersion(1),
              },
              usage: modelUsage({
                modelInputTokens: 400,
                modelOutputTokens: 200,
                vendorUsdMicros: 25,
              }),
            });
          },
          recordCompanyCost: ({ vendorUsdMicros }) =>
            Effect.sync(() => costs.push(vendorUsdMicros)),
        });

        const outcome = yield* coordinator.run({
          availability,
          candidate,
          load,
          nowEpochMillis: 1_788_000_000_100,
        });

        expect(outcome).toMatchObject({
          _tag: "Learned",
          change: "created",
          notification:
            "I learned a reusable weekly status report procedure. You can ask me to undo it.",
          undo: { skillId: "weekly-status", targetSkillVersion: null },
        });
        expect(created).toEqual(["weekly-status-v1"]);
        expect(settled).toEqual(["accepted"]);
        expect(costs).toEqual([25]);
      }),
  );

  it.effect("isolates model failure, malformed output, and company backpressure", () =>
    Effect.gen(function* () {
      const released: Array<string> = [];
      const failing = makeSkillLearningCoordinator({
        authority: fakeAuthority({ released }),
        propose: () => Effect.fail("model unavailable"),
        recordCompanyCost: () => Effect.void,
      });
      expect(
        yield* failing.run({
          availability,
          candidate,
          load,
          nowEpochMillis: 1_788_000_000_100,
        }),
      ).toMatchObject({ _tag: "Deferred", reason: "modelFailure" });
      expect(released).toEqual(["candidate-1"]);

      let malformedCostRecorded = false;
      const malformed = makeSkillLearningCoordinator({
        authority: fakeAuthority({ released }),
        propose: () =>
          Effect.succeed({
            proposal: { _tag: "Change", version: { instructions: "```sh" } },
            usage: modelUsage(),
          }),
        recordCompanyCost: () =>
          Effect.sync(() => {
            malformedCostRecorded = true;
          }),
      });
      expect(
        yield* malformed.run({
          availability,
          candidate: { ...candidate, candidateId: SkillLearningCandidateId.make("candidate-2") },
          load,
          nowEpochMillis: 1_788_000_000_100,
        }),
      ).toMatchObject({ _tag: "Rejected", reason: "malformedProposal" });
      expect(malformedCostRecorded).toBe(true);

      let proposed = false;
      const backpressured = makeSkillLearningCoordinator({
        authority: unusedAuthority(),
        propose: () => {
          proposed = true;
          return Effect.die(new Error("unexpected proposal"));
        },
        recordCompanyCost: () => Effect.void,
      });
      expect(
        yield* backpressured.run({
          availability,
          candidate,
          load: { ...load, concurrentJobsForUser: 1 },
          nowEpochMillis: 1_788_000_000_100,
        }),
      ).toEqual({ _tag: "Deferred", reason: "backpressure" });
      expect(proposed).toBe(false);
    }),
  );

  it.effect("rebases one stale learner once without losing the winning revision", () =>
    Effect.gen(function* () {
      const first = {
        ...skillVersion(1),
        skillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
      };
      const winner = {
        ...skillVersion(2),
        parentSkillVersion: first.skillVersion,
        skillVersion: PersonalSkillVersionId.make("weekly-status-v2"),
      };
      const converged = {
        ...skillVersion(3),
        parentSkillVersion: winner.skillVersion,
        skillVersion: PersonalSkillVersionId.make("weekly-status-v3"),
      };
      const revisingCandidate = {
        ...candidate,
        priorSkillId: first.skillId,
        priorSkillVersion: first.skillVersion,
      };
      let activations = 0;
      let proposals = 0;
      const coordinator = makeSkillLearningCoordinator({
        authority: {
          ...unusedAuthority(),
          activateLearning: ({ version }: { readonly version: unknown }) => {
            activations += 1;
            if (activations === 1) {
              return Effect.fail(
                new PersonalSkillConflict({
                  actualSkillVersion: winner.skillVersion,
                  expectedSkillVersion: first.skillVersion,
                  message: "another learner won",
                  skillId: first.skillId,
                }),
              );
            }
            const decoded = Schema.decodeUnknownResult(PersonalSkillVersion)(version);
            return decoded._tag === "Failure"
              ? Effect.die(decoded.failure)
              : Effect.succeed({ _tag: "Revised" as const, version: decoded.success });
          },
          claimLearning: () =>
            Effect.succeed({
              _tag: "Claimed" as const,
              attempts: 1,
              candidate: revisingCandidate,
              claimToken: "claim-rebase",
            }),
          enqueueLearning: () =>
            Effect.succeed({ _tag: "Queued" as const, candidateId: candidate.candidateId }),
          pin: () => Effect.succeed(proposals === 0 ? first : winner),
          releaseLearning: () => Effect.void,
          settleLearning: () => Effect.void,
        },
        propose: ({ priorVersion }) => {
          proposals += 1;
          const next = proposals === 1 ? winner : converged;
          expect(priorVersion?.skillVersion).toBe(
            proposals === 1 ? first.skillVersion : winner.skillVersion,
          );
          return Effect.succeed({
            proposal: {
              _tag: "Change",
              evidence: "explicitConfirmation",
              materiality: "minor",
              skillsChanged: 1,
              version: next,
            },
            usage: modelUsage(),
          });
        },
        recordCompanyCost: () => Effect.void,
      });
      const outcome = yield* coordinator.run({
        availability,
        candidate: revisingCandidate,
        load,
        nowEpochMillis: 1_788_000_000_100,
      });
      expect(outcome).toMatchObject({
        _tag: "Learned",
        change: "revised",
        notification: null,
        undo: { targetSkillVersion: winner.skillVersion },
        version: { skillVersion: converged.skillVersion },
      });
      expect(activations).toBe(2);
      expect(proposals).toBe(2);
    }),
  );
});

const modelUsage = (
  overrides: Partial<{
    readonly modelInputTokens: number;
    readonly modelOutputTokens: number;
    readonly vendorUsdMicros: number;
  }> = {},
) => ({
  costBasis: "observed" as const,
  modelInputTokens: overrides.modelInputTokens ?? 10,
  modelOutputTokens: overrides.modelOutputTokens ?? 10,
  vendorUsdMicros: overrides.vendorUsdMicros ?? 1,
});

const skillVersion = (revision: number) => ({
  allowedOrigins: ["channelLink"] as const,
  capabilityIds: ["document-generation"] as const,
  createdAtEpochMillis: 1_788_000_000_100,
  createdBy: "learning" as const,
  creationEvidence: candidate.evidence,
  description: "Reusable weekly status report procedure.",
  instructions: "Put the executive summary before the detail.",
  keywords: ["weekly status", "status report"],
  lastUsedAtEpochMillis: null,
  origin: "learned" as const,
  outcomeFacts: { confirmedFailures: 0, confirmedSuccesses: 1 },
  ownerUserId: userId,
  parentSkillVersion: null,
  requirements: ["document-renderer"] as const,
  revision,
  skillId: PersonalSkillId.make("weekly-status"),
  skillVersion: PersonalSkillVersionId.make(`weekly-status-v${revision}`),
  status: "active" as const,
  taskDescription: candidate.taskDescription,
  taskKinds: ["document"] as const,
  updatedAtEpochMillis: 1_788_000_000_100,
  updateEvidence: [],
});

const fakeAuthority = (observed: {
  readonly created?: Array<string>;
  readonly released?: Array<string>;
  readonly settled?: Array<string>;
}) => ({
  claimLearning: () =>
    Effect.succeed({ _tag: "Claimed" as const, attempts: 1, candidate, claimToken: "claim-1" }),
  activateLearning: ({ version }: { readonly version: unknown }) =>
    Schema.decodeUnknownEffect(PersonalSkillVersion)(version).pipe(
      Effect.tap((current) =>
        Effect.sync(() => {
          observed.created?.push(current.skillVersion);
          observed.settled?.push("accepted");
        }),
      ),
      Effect.map((current) => ({ _tag: "Created" as const, version: current })),
    ),
  enqueueLearning: (input: SkillLearningCandidate) =>
    Effect.succeed({ _tag: "Queued" as const, candidateId: input.candidateId }),
  pin: () => Effect.die(new Error("unexpected pin")),
  releaseLearning: (input: { readonly candidateId: string }) =>
    Effect.sync(() => observed.released?.push(input.candidateId)),
  settleLearning: (input: { readonly status: string }) =>
    Effect.sync(() => observed.settled?.push(input.status)),
});

const unusedAuthority = () => ({
  claimLearning: () => Effect.die(new Error("unexpected claim")),
  activateLearning: () => Effect.die(new Error("unexpected activation")),
  enqueueLearning: () => Effect.die(new Error("unexpected enqueue")),
  pin: () => Effect.die(new Error("unexpected pin")),
  releaseLearning: () => Effect.die(new Error("unexpected release")),
  settleLearning: () => Effect.die(new Error("unexpected settle")),
});
