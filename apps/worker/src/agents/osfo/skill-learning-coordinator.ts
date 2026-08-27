/* oxlint-disable eslint/no-underscore-dangle -- Effect and domain tagged unions use _tag. */
/* oxlint-disable effecttsgo/crypto-random-uuid-in-effect -- Claim tokens require production entropy rather than deterministic test randomness. */
/* oxlint-disable effecttsgo/global-date-in-effect -- The policy boundary accepts epoch milliseconds and constructs dates without reading global time. */
/* oxlint-disable effecttsgo/prefer-schema-over-json -- The encoded byte measurement never parses or trusts JSON. */

import { Cause, Effect, Option, Predicate, Result, Schema } from "effect";

import { evaluateSkillLearning } from "../../domain/skill-learning";
import {
  PersonalSkillVersion,
  type SkillLearningCandidate,
  type SkillLearningCandidateId,
  SkillLearningModelAttemptId,
} from "../../domain/personal-skill";
import { currentCapabilityCatalog } from "../../domain/capability-catalog";
import type {
  PersonalSkillLearningLoad,
  PersonalSkillAvailability,
  SkillLearningClaim,
} from "./personal-skill-authority";
import {
  makeSkillLearningAdmission,
  type SkillLearningAdmission,
} from "./skill-learning-admission";

const workerSkillLearningAdmission = makeSkillLearningAdmission(
  currentCapabilityCatalog.skillLearning.concurrentJobsGlobally,
);

/** Current company-funded frequency, retention, and concurrency facts. */
export interface SkillLearningLoad extends PersonalSkillLearningLoad {}

/** Exact trusted input supplied to the isolated learning model. */
export interface SkillLearningModelInput {
  readonly attemptId: SkillLearningModelAttemptId;
  readonly candidate: SkillLearningCandidate;
  readonly priorVersion: PersonalSkillVersion | null;
}

const AttemptUsage = Schema.Struct({
  costBasis: Schema.Literals(["conservative", "observed"]),
  modelInputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  modelOutputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  vendorUsdMicros: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Trusted adapter result pairing untrusted semantic output with measured attempt evidence. */
export const SkillLearningModelResult = Schema.Struct({
  proposal: Schema.Unknown,
  usage: AttemptUsage,
});

/** Trusted adapter result pairing untrusted semantic output with measured attempt evidence. */
export type SkillLearningModelResult = typeof SkillLearningModelResult.Type;

/** Closed model output. Unknown fields and unsafe Skill bodies are rejected. */
export const SkillLearningProposal = Schema.TaggedUnion({
  Change: {
    evidence: Schema.Literals(["confirmedEffect", "explicitConfirmation", "successfulReuse"]),
    materiality: Schema.Literals(["material", "minor"]),
    skillsChanged: Schema.Int.check(Schema.isGreaterThan(0)),
    version: PersonalSkillVersion,
  },
  NoChange: {},
});

/** Closed model output. Unknown fields and unsafe Skill bodies are rejected. */
export type SkillLearningProposal = typeof SkillLearningProposal.Type;

interface LearningAuthority<Error> {
  readonly activateLearning: (input: {
    readonly availability: PersonalSkillAvailability;
    readonly candidateId: SkillLearningCandidateId;
    readonly claimToken: string;
    readonly expectedSkillVersion: PersonalSkillVersion["skillVersion"] | null;
    readonly notification: string | null;
    readonly nowEpochMillis: number;
    readonly undoTargetSkillVersion: PersonalSkillVersion["skillVersion"] | null;
    readonly userId: SkillLearningCandidate["ownerUserId"];
    readonly version: unknown;
  }) => Effect.Effect<
    { readonly _tag: "Created" | "Revised"; readonly version: PersonalSkillVersion },
    Error
  >;
  readonly claimLearning: (input: {
    readonly candidateId: SkillLearningCandidateId;
    readonly claimToken: string;
    readonly leaseMilliseconds: number;
    readonly nowEpochMillis: number;
    readonly userId: SkillLearningCandidate["ownerUserId"];
  }) => Effect.Effect<SkillLearningClaim, Error>;
  readonly enqueueLearning: (candidate: SkillLearningCandidate) => Effect.Effect<
    {
      readonly _tag?: "AlreadyQueued" | "Backpressured" | "Queued";
      readonly candidateId: SkillLearningCandidateId;
    },
    Error
  >;
  readonly pin: (input: {
    readonly skillId: NonNullable<SkillLearningCandidate["priorSkillId"]>;
    readonly skillVersion?: NonNullable<SkillLearningCandidate["priorSkillVersion"]>;
    readonly userId: SkillLearningCandidate["ownerUserId"];
  }) => Effect.Effect<PersonalSkillVersion, Error>;
  readonly releaseLearning: (input: {
    readonly candidateId: SkillLearningCandidateId;
    readonly claimToken: string;
    readonly nowEpochMillis: number;
    readonly userId: SkillLearningCandidate["ownerUserId"];
  }) => Effect.Effect<void, Error>;
  readonly settleLearning: (input: {
    readonly candidateId: SkillLearningCandidateId;
    readonly claimToken: string;
    readonly nowEpochMillis: number;
    readonly status: "rejected";
    readonly userId: SkillLearningCandidate["ownerUserId"];
  }) => Effect.Effect<void, Error>;
}

export interface SkillLearningRunInput {
  readonly availability: PersonalSkillAvailability;
  readonly candidate: SkillLearningCandidate | null;
  readonly load: SkillLearningLoad;
  readonly nowEpochMillis: number;
}

export type SkillLearningOutcome =
  | {
      readonly _tag: "Deferred";
      readonly reason: "backpressure" | "modelFailure" | "storageFailure";
    }
  | {
      readonly _tag: "Learned";
      readonly change: "created" | "revised";
      readonly notification: string | null;
      readonly undo: {
        readonly skillId: PersonalSkillVersion["skillId"];
        readonly targetSkillVersion: PersonalSkillVersion["skillVersion"] | null;
      };
      readonly version: PersonalSkillVersion;
    }
  | {
      readonly _tag: "NoLearning";
      readonly reason: "alreadySettled" | "noMaterialChange" | "noReusableLearning";
    }
  | {
      readonly _tag: "Rejected";
      readonly reason: "limits" | "malformedProposal";
    };

/** Build the post-root-commit coordinator. Every operational failure stays isolated. */
export const makeSkillLearningCoordinator = <AuthorityError, ModelError, CostError>(dependencies: {
  readonly authority: LearningAuthority<AuthorityError>;
  readonly propose: (input: SkillLearningModelInput) => Effect.Effect<unknown, ModelError>;
  readonly recordCompanyCost: (input: {
    readonly attemptId: SkillLearningModelAttemptId;
    readonly basis: "conservative" | "observed";
    readonly candidateId: SkillLearningCandidateId;
    readonly modelInputTokens: number;
    readonly modelOutputTokens: number;
    readonly outcome: "failure" | "success";
    readonly recordedAtEpochMillis: number;
    readonly userId: SkillLearningCandidate["ownerUserId"];
    readonly vendorUsdMicros: number;
  }) => Effect.Effect<void, CostError>;
  readonly admission?: SkillLearningAdmission;
}) => ({
  run: Effect.fn("SkillLearningCoordinator.run")(function* (
    input: SkillLearningRunInput,
  ): Effect.fn.Return<SkillLearningOutcome> {
    const candidate = input.candidate;
    if (candidate === null) {
      return { _tag: "NoLearning", reason: "noReusableLearning" };
    }
    if (isBackpressured(candidate, input.load, input.nowEpochMillis)) {
      return { _tag: "Deferred", reason: "backpressure" };
    }

    const permit = yield* (dependencies.admission ?? workerSkillLearningAdmission).acquire;
    if (Option.isNone(permit)) return { _tag: "Deferred", reason: "backpressure" };

    return yield* Effect.gen(function* () {
      const queued = yield* Effect.exit(dependencies.authority.enqueueLearning(candidate));
      if (queued._tag === "Failure") return { _tag: "Deferred", reason: "storageFailure" } as const;
      if (queued.value._tag === "Backpressured") {
        return { _tag: "Deferred", reason: "backpressure" } as const;
      }
      const claimToken = crypto.randomUUID();
      const claimed = yield* Effect.exit(
        dependencies.authority.claimLearning({
          candidateId: candidate.candidateId,
          claimToken,
          leaseMilliseconds: 30_000,
          nowEpochMillis: input.nowEpochMillis,
          userId: candidate.ownerUserId,
        }),
      );
      if (claimed._tag === "Failure")
        return { _tag: "Deferred", reason: "storageFailure" } as const;
      if (claimed.value._tag === "Busy")
        return { _tag: "Deferred", reason: "backpressure" } as const;
      if (claimed.value._tag === "Settled") {
        return { _tag: "NoLearning", reason: "alreadySettled" } as const;
      }
      const claim = claimed.value;
      const priorVersion = yield* resolvePrior(dependencies.authority, claim.candidate);
      if (Result.isFailure(priorVersion)) {
        yield* releaseClaim(dependencies.authority, claim, input.nowEpochMillis);
        return { _tag: "Deferred", reason: "storageFailure" } as const;
      }
      const proposed = yield* Effect.exit(
        dependencies.propose({
          attemptId: modelAttemptId(claim.candidate.candidateId, claim.attempts, "initial"),
          candidate: claim.candidate,
          priorVersion: priorVersion.success,
        }),
      );
      if (proposed._tag === "Failure") {
        yield* releaseClaim(dependencies.authority, claim, input.nowEpochMillis);
        return { _tag: "Deferred", reason: "modelFailure" } as const;
      }
      const modelResult = Schema.decodeUnknownResult(SkillLearningModelResult)(proposed.value, {
        onExcessProperty: "error",
      });
      if (Result.isFailure(modelResult)) {
        yield* settleRejected(dependencies.authority, claim, input.nowEpochMillis);
        return { _tag: "Rejected", reason: "malformedProposal" } as const;
      }
      const costRecorded = yield* Effect.exit(
        dependencies.recordCompanyCost({
          attemptId: modelAttemptId(claim.candidate.candidateId, claim.attempts, "initial"),
          basis: modelResult.success.usage.costBasis,
          candidateId: claim.candidate.candidateId,
          modelInputTokens: modelResult.success.usage.modelInputTokens,
          modelOutputTokens: modelResult.success.usage.modelOutputTokens,
          outcome: "success",
          recordedAtEpochMillis: input.nowEpochMillis,
          userId: claim.candidate.ownerUserId,
          vendorUsdMicros: modelResult.success.usage.vendorUsdMicros,
        }),
      );
      if (costRecorded._tag === "Failure") {
        yield* releaseClaim(dependencies.authority, claim, input.nowEpochMillis);
        return { _tag: "Deferred", reason: "storageFailure" } as const;
      }
      const decoded = Schema.decodeUnknownResult(SkillLearningProposal)(
        modelResult.success.proposal,
        {
          onExcessProperty: "error",
        },
      );
      if (Result.isFailure(decoded)) {
        yield* settleRejected(dependencies.authority, claim, input.nowEpochMillis);
        return { _tag: "Rejected", reason: "malformedProposal" } as const;
      }
      const proposal = decoded.success;
      if (proposal._tag === "NoChange") {
        yield* settleRejected(dependencies.authority, claim, input.nowEpochMillis);
        return { _tag: "NoLearning", reason: "noMaterialChange" } as const;
      }
      const verdict = evaluateSkillLearning(
        {
          attempts: claim.attempts,
          candidateBytes: claim.candidate.candidateBytes,
          createdAt: new Date(claim.candidate.createdAtEpochMillis),
          id: claim.candidate.candidateId,
        },
        {
          evidence: proposal.evidence,
          modelInputTokens: modelResult.success.usage.modelInputTokens,
          modelOutputTokens: modelResult.success.usage.modelOutputTokens,
          skillBodyBytes: BigInt(encodedBytes(proposal.version.instructions)),
          skillVersionBytes: BigInt(encodedBytes(JSON.stringify(proposal.version))),
          skillsChanged: proposal.skillsChanged,
        },
        input.load,
        new Date(input.nowEpochMillis),
      );
      if (verdict._tag !== "Accepted") {
        yield* settleRejected(dependencies.authority, claim, input.nowEpochMillis);
        return verdict._tag === "Backpressured"
          ? ({ _tag: "Deferred", reason: "backpressure" } as const)
          : ({ _tag: "Rejected", reason: "limits" } as const);
      }

      const changed = yield* Effect.exit(
        dependencies.authority.activateLearning({
          availability: input.availability,
          candidateId: claim.candidate.candidateId,
          claimToken: claim.claimToken,
          expectedSkillVersion: priorVersion.success?.skillVersion ?? null,
          notification:
            proposal.materiality === "material"
              ? materialChangeNotification(proposal.version.description)
              : null,
          nowEpochMillis: input.nowEpochMillis,
          undoTargetSkillVersion: priorVersion.success?.skillVersion ?? null,
          userId: claim.candidate.ownerUserId,
          version: proposal.version,
        }),
      );
      if (changed._tag === "Failure") {
        const activationError = Option.getOrUndefined(Cause.findErrorOption(changed.cause));
        if (
          priorVersion.success !== null &&
          Predicate.isTagged(activationError, "PersonalSkillConflict")
        ) {
          const converged = yield* convergeStaleRevision({
            authority: dependencies.authority,
            availability: input.availability,
            attempts: claim.attempts,
            candidate: claim.candidate,
            claimToken: claim.claimToken,
            nowEpochMillis: input.nowEpochMillis,
            load: input.load,
            propose: dependencies.propose,
            recordCompanyCost: dependencies.recordCompanyCost,
          });
          if (Result.isSuccess(converged)) {
            const version = converged.success.version;
            return {
              _tag: "Learned",
              change: "revised",
              notification:
                converged.success.materiality === "material"
                  ? materialChangeNotification(version.description)
                  : null,
              undo: {
                skillId: version.skillId,
                targetSkillVersion: converged.success.previousSkillVersion,
              },
              version,
            } as const;
          }
        }
        yield* releaseClaim(dependencies.authority, claim, input.nowEpochMillis);
        return { _tag: "Deferred", reason: "storageFailure" } as const;
      }
      const version = changed.value.version;
      return {
        _tag: "Learned",
        change: priorVersion.success === null ? "created" : "revised",
        notification:
          proposal.materiality === "material"
            ? materialChangeNotification(version.description)
            : null,
        undo: {
          skillId: version.skillId,
          targetSkillVersion: priorVersion.success?.skillVersion ?? null,
        },
        version,
      } as const;
    }).pipe(Effect.ensuring(permit.value));
  }),
});

const convergeStaleRevision = Effect.fn("SkillLearningCoordinator.convergeStaleRevision")(
  function* <AuthorityError, ModelError, CostError>(input: {
    readonly authority: LearningAuthority<AuthorityError>;
    readonly availability: PersonalSkillAvailability;
    readonly attempts: number;
    readonly candidate: SkillLearningCandidate;
    readonly claimToken: string;
    readonly nowEpochMillis: number;
    readonly load: SkillLearningLoad;
    readonly propose: (input: SkillLearningModelInput) => Effect.Effect<unknown, ModelError>;
    readonly recordCompanyCost: (input: {
      readonly attemptId: SkillLearningModelAttemptId;
      readonly basis: "conservative" | "observed";
      readonly candidateId: SkillLearningCandidateId;
      readonly modelInputTokens: number;
      readonly modelOutputTokens: number;
      readonly outcome: "failure" | "success";
      readonly recordedAtEpochMillis: number;
      readonly userId: SkillLearningCandidate["ownerUserId"];
      readonly vendorUsdMicros: number;
    }) => Effect.Effect<void, CostError>;
  }) {
    if (input.candidate.priorSkillId === null) return Result.fail("missingPrior" as const);
    const current = yield* Effect.exit(
      input.authority.pin({
        skillId: input.candidate.priorSkillId,
        userId: input.candidate.ownerUserId,
      }),
    );
    if (current._tag === "Failure") return Result.fail("storage" as const);
    const proposed = yield* Effect.exit(
      input.propose({
        attemptId: modelAttemptId(input.candidate.candidateId, input.attempts, "rebase"),
        candidate: input.candidate,
        priorVersion: current.value,
      }),
    );
    if (proposed._tag === "Failure") return Result.fail("model" as const);
    const modelResult = Schema.decodeUnknownResult(SkillLearningModelResult)(proposed.value, {
      onExcessProperty: "error",
    });
    if (Result.isFailure(modelResult)) return Result.fail("proposal" as const);
    const decoded = Schema.decodeUnknownResult(SkillLearningProposal)(
      modelResult.success.proposal,
      {
        onExcessProperty: "error",
      },
    );
    if (Result.isFailure(decoded) || decoded.success._tag !== "Change") {
      return Result.fail("proposal" as const);
    }
    const verdict = evaluateSkillLearning(
      {
        attempts: input.attempts,
        candidateBytes: input.candidate.candidateBytes,
        createdAt: new Date(input.candidate.createdAtEpochMillis),
        id: input.candidate.candidateId,
      },
      {
        evidence: decoded.success.evidence,
        modelInputTokens: modelResult.success.usage.modelInputTokens,
        modelOutputTokens: modelResult.success.usage.modelOutputTokens,
        skillBodyBytes: BigInt(encodedBytes(decoded.success.version.instructions)),
        skillVersionBytes: BigInt(encodedBytes(JSON.stringify(decoded.success.version))),
        skillsChanged: decoded.success.skillsChanged,
      },
      input.load,
      new Date(input.nowEpochMillis),
    );
    if (verdict._tag !== "Accepted") return Result.fail("limits" as const);
    const cost = yield* Effect.exit(
      input.recordCompanyCost({
        attemptId: modelAttemptId(input.candidate.candidateId, input.attempts, "rebase"),
        basis: modelResult.success.usage.costBasis,
        candidateId: input.candidate.candidateId,
        modelInputTokens: modelResult.success.usage.modelInputTokens,
        modelOutputTokens: modelResult.success.usage.modelOutputTokens,
        outcome: "success",
        recordedAtEpochMillis: input.nowEpochMillis,
        userId: input.candidate.ownerUserId,
        vendorUsdMicros: modelResult.success.usage.vendorUsdMicros,
      }),
    );
    if (cost._tag === "Failure") return Result.fail("cost" as const);
    const activated = yield* Effect.exit(
      input.authority.activateLearning({
        availability: input.availability,
        candidateId: input.candidate.candidateId,
        claimToken: input.claimToken,
        expectedSkillVersion: current.value.skillVersion,
        notification:
          decoded.success.materiality === "material"
            ? materialChangeNotification(decoded.success.version.description)
            : null,
        nowEpochMillis: input.nowEpochMillis,
        undoTargetSkillVersion: current.value.skillVersion,
        userId: input.candidate.ownerUserId,
        version: decoded.success.version,
      }),
    );
    return activated._tag === "Failure"
      ? Result.fail("activation" as const)
      : Result.succeed({
          materiality: decoded.success.materiality,
          previousSkillVersion: current.value.skillVersion,
          version: activated.value.version,
        });
  },
);

const resolvePrior = <Error>(
  authority: LearningAuthority<Error>,
  candidate: SkillLearningCandidate,
) =>
  candidate.priorSkillId === null
    ? Effect.succeed(Result.succeed<PersonalSkillVersion | null>(null))
    : Effect.match(
        authority.pin(
          candidate.priorSkillVersion === null
            ? { skillId: candidate.priorSkillId, userId: candidate.ownerUserId }
            : {
                skillId: candidate.priorSkillId,
                skillVersion: candidate.priorSkillVersion,
                userId: candidate.ownerUserId,
              },
        ),
        {
          onFailure: Result.fail,
          onSuccess: (version) => Result.succeed<PersonalSkillVersion | null>(version),
        },
      );

const releaseClaim = <Error>(
  authority: LearningAuthority<Error>,
  claim: Extract<SkillLearningClaim, { readonly _tag: "Claimed" }>,
  nowEpochMillis: number,
) =>
  authority
    .releaseLearning({
      candidateId: claim.candidate.candidateId,
      claimToken: claim.claimToken,
      nowEpochMillis,
      userId: claim.candidate.ownerUserId,
    })
    .pipe(Effect.ignore);

const settleRejected = <Error>(
  authority: LearningAuthority<Error>,
  claim: Extract<SkillLearningClaim, { readonly _tag: "Claimed" }>,
  nowEpochMillis: number,
) =>
  authority
    .settleLearning({
      candidateId: claim.candidate.candidateId,
      claimToken: claim.claimToken,
      nowEpochMillis,
      status: "rejected",
      userId: claim.candidate.ownerUserId,
    })
    .pipe(Effect.ignore);

const isBackpressured = (
  candidate: SkillLearningCandidate,
  load: SkillLearningLoad,
  nowEpochMillis: number,
): boolean => {
  const limits = currentCapabilityCatalog.skillLearning;
  return (
    nowEpochMillis - candidate.createdAtEpochMillis > limits.candidateLifetimeMilliseconds ||
    candidate.candidateBytes > limits.candidateBytes ||
    load.jobsInRollingDay >= limits.jobsPerRollingDay ||
    load.concurrentJobsForUser >= limits.concurrentJobsPerUser ||
    load.concurrentJobsGlobally >= limits.concurrentJobsGlobally ||
    load.retainedSkills >= limits.retainedSkillsPerUser ||
    load.retainedSkillHistoryBytes >= limits.retainedSkillHistoryBytes
  );
};

const materialChangeNotification = (description: string): string => {
  const plain = description.replace(/[.!?]+$/u, "");
  const first = plain.charAt(0).toLocaleLowerCase("en");
  return `I learned a ${first}${plain.slice(1)}. You can ask me to undo it.`;
};

const encodedBytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const modelAttemptId = (
  candidateId: SkillLearningCandidateId,
  claimAttempt: number,
  phase: "initial" | "rebase",
): SkillLearningModelAttemptId =>
  SkillLearningModelAttemptId.make(`${candidateId}:claim-${claimAttempt}:${phase}`);

export * as SkillLearningCoordinator from "./skill-learning-coordinator";
