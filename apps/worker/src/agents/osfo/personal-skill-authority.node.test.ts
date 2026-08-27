/* oxlint-disable osfo/no-runtime-typeof -- The test adapter normalizes node:sqlite's closed value union. */
/* oxlint-disable typescript/no-unnecessary-type-parameters -- SqlStorageCursor requires its generic method shape. */
/* oxlint-disable vitest/no-standalone-expect, eslint/no-underscore-dangle -- Effect Vitest executes generator assertions inside each test, and tagged unions use _tag. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- The node:sqlite adapter proves its closed value conversions beside each cast. */
/* oxlint-disable typescript/no-misused-spread -- Test fixtures copy decoded immutable schema values intentionally. */

import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import type { UIMessage } from "ai";
import { Effect, Exit, Option, Schema } from "effect";

import {
  AssistantMessageId,
  CapabilityCatalogVersion,
  ThinkRequestId,
  ThinkSubmissionId,
  UserId,
} from "../../domain";
import { ManagedTurnMetadata } from "../../domain/managed-conversation";
import {
  PersonalSkillId,
  PersonalSkillVersionId,
  SkillLearningCandidateId,
  SkillLearningModelAttemptId,
} from "../../domain/personal-skill";
import { CommittedTurnReceipt } from "./db/store";
import { makeGoodRootOutcomeEvaluator } from "./good-root-outcome-evaluator";
import { CommittedTurnTerminal, withCommittedTurnTerminal } from "./committed-turn-terminal";
import {
  makeGoodRootOutcomeEvaluatorAuthority,
  makePersonalSkillAuthority,
  type PersonalSkillAuthorityStorage,
} from "./personal-skill-authority";
import { proposeConfirmedSkillChange } from "./post-turn-skill-learning";
import { makeSkillLearningCoordinator } from "./skill-learning-coordinator";
import { Capabilities } from "../../services/capabilities";
import { makePersonalSkillTools, SkillManageInput } from "./personal-skill-tools";
import { makePersonalSkillControl } from "./personal-skill-control";
import {
  ingestGoodRootEvaluation,
  recoverPersonalSkillLearning,
  selectPersonalSkillsForTurn,
} from "./personal-skill-runtime";

const userId = UserId.make("user-1");
const availability = {
  capabilityIds: ["document-generation"],
  requirements: ["document-renderer"],
} as const;

const version = (revision: number, instructions = `Procedure ${revision}`) => ({
  allowedOrigins: ["channelLink"] as const,
  capabilityIds: ["document-generation"] as const,
  createdAtEpochMillis: 1_788_000_000_000,
  createdBy: revision === 1 ? ("learning" as const) : ("user" as const),
  creationEvidence: [
    { _tag: "ExplicitUserCorrection" as const, referenceId: "correction-1" },
    { _tag: "ConfirmedRootOutcome" as const, referenceId: "turn-1" },
  ],
  description: "Prepare the User's weekly status report.",
  instructions,
  keywords: ["weekly status", "status report"],
  lastUsedAtEpochMillis: null,
  origin: "learned" as const,
  outcomeFacts: { confirmedFailures: 0, confirmedSuccesses: revision },
  ownerUserId: userId,
  parentSkillVersion:
    revision === 1 ? null : PersonalSkillVersionId.make(`weekly-status-v${revision - 1}`),
  requirements: ["document-renderer"] as const,
  revision,
  skillId: PersonalSkillId.make("weekly-status"),
  skillVersion: PersonalSkillVersionId.make(`weekly-status-v${revision}`),
  status: "active" as const,
  taskDescription: "Create the weekly status report as a PDF.",
  taskKinds: ["document"] as const,
  updatedAtEpochMillis: 1_788_000_000_000 + revision,
  updateEvidence:
    revision === 1
      ? []
      : [{ _tag: "ExplicitUserCorrection" as const, referenceId: `correction-${revision}` }],
});

const learningCandidate = (candidateId = "candidate-1") => ({
  availableCapabilityIds: ["document-generation" as const],
  availableRequirements: ["document-renderer" as const],
  candidateBytes: 200n,
  candidateId: SkillLearningCandidateId.make(candidateId),
  corrections: ["Put the summary first."],
  createdAtEpochMillis: 1_788_000_000_000,
  decisions: ["Keep weekly reports under five pages."],
  evidence: [
    { _tag: "ExplicitUserCorrection" as const, referenceId: "correction-1" },
    { _tag: "ConfirmedRootOutcome" as const, referenceId: "turn-1" },
  ],
  ownerUserId: userId,
  priorSkillId: null,
  priorSkillVersion: null,
  rootAssistantMessageId: AssistantMessageId.make("assistant-1"),
  rootOutcomeReferenceId: "turn-1",
  taskDescription: "Create the weekly status report as a PDF.",
});

describe("PersonalSkillAuthority", () => {
  it.effect("creates, inspects, revises, and preserves the exact pinned version", () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const authority = makePersonalSkillAuthority(storage);
        const created = yield* authority.create({ availability, version: version(1) });
        expect(created._tag).toBe("Created");

        const pinned = yield* authority.pin({
          skillId: PersonalSkillId.make("weekly-status"),
          userId,
        });
        expect(pinned.skillVersion).toBe("weekly-status-v1");

        const revised = yield* authority.revise({
          availability,
          expectedSkillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
          version: version(2, "Put the executive summary before the detail."),
        });
        expect(revised._tag).toBe("Revised");

        const exactPinned = yield* authority.pin({
          skillId: PersonalSkillId.make("weekly-status"),
          skillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
          userId,
        });
        expect(exactPinned.instructions).toBe("Procedure 1");

        const inspected = yield* authority.inspect({
          skillId: PersonalSkillId.make("weekly-status"),
          userId,
        });
        expect(inspected.current.skillVersion).toBe("weekly-status-v2");
        expect(inspected.versions.map(({ skillVersion }) => skillVersion)).toEqual([
          "weekly-status-v1",
          "weekly-status-v2",
        ]);
      }),
    ),
  );

  it.effect(
    "fences stale and cross-User writers before they can replace a confirmed revision",
    () =>
      withDatabase((storage) =>
        Effect.gen(function* () {
          const authority = makePersonalSkillAuthority(storage);
          yield* authority.create({ availability, version: version(1) });
          yield* authority.revise({
            availability,
            expectedSkillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
            version: version(2),
          });

          const stale = yield* Effect.exit(
            authority.revise({
              availability,
              expectedSkillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
              version: version(2, "A stale rewrite"),
            }),
          );
          expect(Exit.isFailure(stale)).toBe(true);

          const otherUser = yield* Effect.exit(
            authority.pin({
              skillId: PersonalSkillId.make("weekly-status"),
              userId: UserId.make("user-2"),
            }),
          );
          expect(Exit.isFailure(otherUser)).toBe(true);
          const current = yield* authority.pin({
            skillId: PersonalSkillId.make("weekly-status"),
            userId,
          });
          expect(current.instructions).toBe("Procedure 2");
        }),
      ),
  );

  it.effect("rejects unknown envelopes and currently unavailable capability requirements", () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const authority = makePersonalSkillAuthority(storage);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              authority.create({
                availability,
                version: { ...version(1), requirements: ["unknown-runtime"] },
              }),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              authority.create({
                availability,
                version: { ...version(1), capabilityIds: ["web-search"] },
              }),
            ),
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("archives, restores, rolls back, deletes, and removes the account lineage", () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const authority = makePersonalSkillAuthority(storage);
        yield* authority.create({ availability, version: version(1) });
        yield* authority.revise({
          availability,
          expectedSkillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
          version: version(2, "Use the revised format."),
        });
        const archived = yield* authority.archive({
          evidence: [{ _tag: "UserDecision", referenceId: "decision-archive" }],
          expectedSkillVersion: PersonalSkillVersionId.make("weekly-status-v2"),
          nowEpochMillis: 1_788_000_000_010,
          skillId: PersonalSkillId.make("weekly-status"),
          userId,
        });
        expect(archived.version.status).toBe("archived");
        expect((yield* authority.all(userId)).map(({ status }) => status)).toEqual(["archived"]);
        expect(yield* authority.active(userId)).toEqual([]);
        expect(yield* authority.active(userId)).toEqual([]);

        const restored = yield* authority.restore({
          availability,
          evidence: [{ _tag: "UserDecision", referenceId: "decision-restore" }],
          expectedSkillVersion: archived.version.skillVersion,
          nowEpochMillis: 1_788_000_000_020,
          skillId: PersonalSkillId.make("weekly-status"),
          userId,
        });
        expect(restored.version.status).toBe("active");

        const rolledBack = yield* authority.rollback({
          availability,
          evidence: [{ _tag: "ExplicitUserCorrection", referenceId: "undo-1" }],
          expectedSkillVersion: restored.version.skillVersion,
          nowEpochMillis: 1_788_000_000_030,
          skillId: PersonalSkillId.make("weekly-status"),
          targetSkillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
          userId,
        });
        expect(rolledBack.version.instructions).toBe("Procedure 1");
        expect(rolledBack.version.createdBy).toBe("rollback");

        yield* authority.recordUse({
          nowEpochMillis: 1_788_000_000_040,
          skillId: PersonalSkillId.make("weekly-status"),
          skillVersion: rolledBack.version.skillVersion,
          userId,
        });
        expect((yield* authority.active(userId))[0]?.lastUsedAtEpochMillis).toBe(1_788_000_000_040);

        yield* authority.delete({
          expectedSkillVersion: rolledBack.version.skillVersion,
          skillId: PersonalSkillId.make("weekly-status"),
          userId,
        });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              authority.pin({ skillId: PersonalSkillId.make("weekly-status"), userId }),
            ),
          ),
        ).toBe(true);

        yield* authority.create({ availability, version: version(1) });
        yield* authority.deleteUserData(userId);
        expect(yield* authority.active(userId)).toEqual([]);
      }),
    ),
  );

  it.effect("leases bounded learning once and fences stale learners", () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const authority = makePersonalSkillAuthority(storage);
        const candidate = learningCandidate();
        expect((yield* authority.enqueueLearning(candidate))._tag).toBe("Queued");
        expect((yield* authority.enqueueLearning(candidate))._tag).toBe("AlreadyQueued");

        const first = yield* authority.claimLearning({
          candidateId: candidate.candidateId,
          claimToken: "claim-1",
          leaseMilliseconds: 1_000,
          nowEpochMillis: 1_788_000_000_010,
          userId,
        });
        expect(first._tag).toBe("Claimed");
        const busy = yield* authority.claimLearning({
          candidateId: candidate.candidateId,
          claimToken: "claim-2",
          leaseMilliseconds: 1_000,
          nowEpochMillis: 1_788_000_000_020,
          userId,
        });
        expect(busy._tag).toBe("Busy");
        expect(
          (yield* authority.enqueueLearning(learningCandidate("candidate-concurrent")))._tag,
        ).toBe("Backpressured");

        yield* authority.releaseLearning({
          candidateId: candidate.candidateId,
          claimToken: "claim-1",
          nowEpochMillis: 1_788_000_000_030,
          userId,
        });
        const second = yield* authority.claimLearning({
          candidateId: candidate.candidateId,
          claimToken: "claim-2",
          leaseMilliseconds: 1_000,
          nowEpochMillis: 1_788_000_000_040,
          userId,
        });
        expect(second).toMatchObject({ _tag: "Claimed", attempts: 2 });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              authority.settleLearning({
                candidateId: candidate.candidateId,
                claimToken: "claim-1",
                nowEpochMillis: 1_788_000_000_050,
                status: "accepted",
                userId,
              }),
            ),
          ),
        ).toBe(true);
        yield* authority.settleLearning({
          candidateId: candidate.candidateId,
          claimToken: "claim-2",
          nowEpochMillis: 1_788_000_000_060,
          status: "accepted",
          userId,
        });
        expect(
          (yield* authority.claimLearning({
            candidateId: candidate.candidateId,
            claimToken: "claim-3",
            leaseMilliseconds: 1_000,
            nowEpochMillis: 1_788_000_000_070,
            userId,
          }))._tag,
        ).toBe("Settled");
      }),
    ),
  );

  it.effect("atomically activates a learned version with its durable candidate settlement", () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const authority = makePersonalSkillAuthority(storage);
        const candidate = learningCandidate("candidate-atomic");
        yield* authority.enqueueLearning(candidate);
        yield* authority.claimLearning({
          candidateId: candidate.candidateId,
          claimToken: "claim-atomic",
          leaseMilliseconds: 1_000,
          nowEpochMillis: 1_788_000_000_010,
          userId,
        });
        const forgedEvidence = yield* Effect.exit(
          authority.activateLearning({
            availability,
            candidateId: candidate.candidateId,
            claimToken: "claim-atomic",
            expectedSkillVersion: null,
            notification: null,
            nowEpochMillis: 1_788_000_000_015,
            undoTargetSkillVersion: null,
            userId,
            version: {
              ...version(1),
              creationEvidence: [
                { _tag: "ExplicitUserCorrection", referenceId: "forged-correction" },
              ],
            },
          }),
        );
        expect(Exit.isFailure(forgedEvidence)).toBe(true);

        const faultyStorage: PersonalSkillAuthorityStorage = {
          sql: {
            exec: (query, ...bindings) => {
              if (
                query.includes("UPDATE osfo_personal_skill_learning_candidates") &&
                query.includes("status = 'accepted'")
              ) {
                throw new Error("simulated activation crash");
              }
              return storage.sql.exec(query, ...bindings);
            },
          },
          transactionSync: storage.transactionSync,
        };
        const crashed = yield* Effect.exit(
          makePersonalSkillAuthority(faultyStorage).activateLearning({
            availability,
            candidateId: candidate.candidateId,
            claimToken: "claim-atomic",
            expectedSkillVersion: null,
            notification: "I learned a weekly status report procedure. You can ask me to undo it.",
            nowEpochMillis: 1_788_000_000_020,
            undoTargetSkillVersion: null,
            userId,
            version: version(1),
          }),
        );
        expect(Exit.isFailure(crashed)).toBe(true);
        expect(yield* authority.active(userId)).toEqual([]);

        const activated = yield* authority.activateLearning({
          availability,
          candidateId: candidate.candidateId,
          claimToken: "claim-atomic",
          expectedSkillVersion: null,
          notification: "I learned a weekly status report procedure. You can ask me to undo it.",
          nowEpochMillis: 1_788_000_000_030,
          undoTargetSkillVersion: null,
          userId,
          version: version(1),
        });
        expect(activated._tag).toBe("Created");
        expect((yield* authority.active(userId))[0]?.skillVersion).toBe("weekly-status-v1");
        const restartedAuthority = makePersonalSkillAuthority(storage);
        const pendingNotifications = yield* restartedAuthority.pendingLearningNotifications;
        expect(pendingNotifications).toMatchObject([
          {
            candidate: { candidateId: "candidate-atomic" },
            notification: "I learned a weekly status report procedure. You can ask me to undo it.",
            undoTargetSkillVersion: null,
            version: { skillVersion: "weekly-status-v1" },
          },
        ]);
        yield* restartedAuthority.markLearningNotificationDelivered({
          candidateId: candidate.candidateId,
          deliveredAtEpochMillis: 1_788_000_000_035,
          skillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
          userId,
        });
        yield* restartedAuthority.markLearningNotificationDelivered({
          candidateId: candidate.candidateId,
          deliveredAtEpochMillis: 1_788_000_000_036,
          skillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
          userId,
        });
        expect(yield* restartedAuthority.pendingLearningNotifications).toEqual([]);
        expect(
          (yield* authority.claimLearning({
            candidateId: candidate.candidateId,
            claimToken: "later-claim",
            leaseMilliseconds: 1_000,
            nowEpochMillis: 1_788_000_000_040,
            userId,
          }))._tag,
        ).toBe("Settled");
      }),
    ),
  );

  it.effect("runs the Agent learning journey and changes only the matching later session", () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const authority = makePersonalSkillAuthority(storage);
        expect(authority).not.toHaveProperty("retainGoodRootEvaluation");
        const submissionId = ThinkSubmissionId.make("submission-journey");
        const assistantMessageId = AssistantMessageId.make("assistant-journey");
        const requestId = ThinkRequestId.make("request-journey");
        const messages = journeyMessages({ assistantMessageId, requestId, submissionId });
        const committed = yield* Schema.decodeEffect(CommittedTurnReceipt)({
          assistantMessageId,
          observationSequence: 1,
          observedAt: "2026-08-27 00:00:00",
          sessionId: "session-journey",
          source: "hook",
          thinkRequestId: requestId,
        });
        const evaluation = yield* makeGoodRootOutcomeEvaluator({
          authority: makeGoodRootOutcomeEvaluatorAuthority(storage),
          facts: {
            readCommittedTurns: Effect.succeed([committed]),
            readMessages: () => messages,
          },
        }).evaluate({
          assistantMessageId,
          evaluatedAtEpochMillis: 1_788_000_000_100,
        });
        expect(Option.isSome(evaluation)).toBe(true);
        if (Option.isNone(evaluation)) return;
        const ingested = yield* ingestGoodRootEvaluation({
          authority,
          committedTurns: [committed],
          messages,
          nowEpochMillis: 1_788_000_000_100,
          reference: evaluation.value,
        });
        expect(ingested._tag).toBe("SkillLearningQueued");
        if (ingested._tag !== "SkillLearningQueued") return;

        const recovered = yield* recoverPersonalSkillLearning(authority, 1_788_000_000_101);
        expect(recovered.map(({ candidateId }) => candidateId)).toEqual([
          ingested.candidate.candidateId,
        ]);
        const coordinator = makeSkillLearningCoordinator({
          authority,
          propose: (input) =>
            Effect.succeed({
              proposal: proposeConfirmedSkillChange(input),
              usage: {
                costBasis: "observed" as const,
                modelInputTokens: 10,
                modelOutputTokens: 10,
                vendorUsdMicros: 1,
              },
            }),
          recordCompanyCost: () => Effect.void,
        });
        const outcome = yield* coordinator.run({
          availability: {
            capabilityIds: ["document-generation"],
            requirements: ["personal-agent"],
          },
          candidate: recovered[0] ?? ingested.candidate,
          load: yield* authority.learningLoad(userId, 1_788_000_000_100),
          nowEpochMillis: 1_788_000_000_100,
        });
        expect(outcome._tag).toBe("Learned");

        const personalSkills = yield* selectPersonalSkillsForTurn({
          authority,
          eligible: [],
          firstInitialization: true,
          userId,
        });
        const capabilities = Capabilities.make();
        const base = {
          availableIntegrationToolkits: [] as const,
          availableRequirements: [
            "document-renderer",
            "file-storage",
            "personal-agent",
            "skill-store",
          ] as const,
          availableToolNames: ["generateDocument", "loadSkill"],
          catalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
          declaredRequirements: [] as const,
          origin: "channelLink" as const,
          personalSkills,
          plan: "free" as const,
          userId,
        };
        const laterSession = yield* capabilities.eligibleIndex({
          ...base,
          taskDescription: "Create this week's weekly report as a PDF.",
          taskKinds: ["document"],
        });
        const learned = laterSession.candidates.find(({ source }) => source === "personal");
        expect(learned).toBeDefined();
        if (learned === undefined) return;
        const loaded = yield* capabilities.loadSkill({
          index: laterSession,
          personalSkills,
          skillId: learned.skillId,
          skillVersion: learned.skillVersion,
          userId,
        });
        expect(loaded.instructions).toContain("put the summary first");

        const recoveredTurnSkills = yield* selectPersonalSkillsForTurn({
          authority,
          eligible: [{ skillId: learned.skillId, skillVersion: learned.skillVersion }],
          firstInitialization: false,
          userId,
        });
        expect(recoveredTurnSkills.map(({ skillVersion }) => skillVersion)).toEqual([
          learned.skillVersion,
        ]);

        const unrelated = yield* capabilities.eligibleIndex({
          ...base,
          taskDescription: "Create a birthday invitation document.",
          taskKinds: ["document"],
        });
        expect(unrelated.candidates.some(({ source }) => source === "personal")).toBe(false);
        expect((yield* authority.active(userId))[0]?.skillVersion).toBe(learned.skillVersion);
      }),
    ),
  );

  it.effect("rejects cross-turn, unsuccessful, and uncommitted evaluator PASS pairings", () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const submissionId = ThinkSubmissionId.make("submission-bound");
        const assistantMessageId = AssistantMessageId.make("assistant-bound");
        const requestId = ThinkRequestId.make("request-bound");
        const committed = yield* Schema.decodeEffect(CommittedTurnReceipt)({
          assistantMessageId,
          observationSequence: 1,
          observedAt: "2026-08-27 00:00:00",
          sessionId: "session-journey",
          source: "hook",
          thinkRequestId: requestId,
        });
        const evaluate = (messages: ReadonlyArray<UIMessage>, receipts = [committed]) =>
          makeGoodRootOutcomeEvaluator({
            authority: makeGoodRootOutcomeEvaluatorAuthority(storage),
            facts: {
              readCommittedTurns: Effect.succeed(receipts),
              readMessages: () => messages,
            },
          }).evaluate({
            assistantMessageId,
            evaluatedAtEpochMillis: 1_788_000_000_100,
          });

        expect(
          Option.isNone(
            yield* evaluate(
              journeyMessages({
                assistantMessageId,
                requestId,
                submissionId,
                terminalSubmissionId: ThinkSubmissionId.make("submission-other"),
              }),
            ),
          ),
        ).toBe(true);
        expect(
          Option.isNone(
            yield* evaluate(
              journeyMessages({ assistantMessageId, requestId, status: "error", submissionId }),
            ),
          ),
        ).toBe(true);
        expect(
          Option.isNone(
            yield* evaluate(journeyMessages({ assistantMessageId, requestId, submissionId }), []),
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("binds inspect and lifecycle management to the current User", () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const tools = makePersonalSkillTools({
          authority: makePersonalSkillAuthority(storage),
          availability: () => availability,
          current: () => ({ decisionReferenceId: "submission-manage", userId }),
          nowEpochMillis: () => 1_788_000_000_200,
        });
        const editable = {
          allowedOrigins: ["channelLink" as const],
          capabilityIds: ["document-generation" as const],
          description: "Prepare the User's weekly status report.",
          instructions: "Put the executive summary before the detail.",
          keywords: ["weekly report"],
          requirements: ["document-renderer" as const],
          taskDescription: "Create a weekly report as a PDF.",
          taskKinds: ["document" as const],
        };
        const created = yield* tools.manage({ _tag: "Create", ...editable });
        expect(created._tag).toBe("Created");
        if (created._tag !== "Created") return;

        const listed = yield* tools.inspect({ _tag: "List" });
        expect(listed._tag).toBe("ActiveSkills");
        if (listed._tag !== "ActiveSkills") return;
        expect(listed.skills).toHaveLength(1);

        const revised = yield* tools.manage({
          _tag: "Revise",
          ...editable,
          expectedSkillVersion: created.version.skillVersion,
          instructions: "Put the decisions and executive summary before the detail.",
          skillId: created.version.skillId,
        });
        expect(revised._tag).toBe("Revised");
        if (revised._tag !== "Revised") return;
        const deletion = yield* tools.manage({
          _tag: "Delete",
          expectedSkillVersion: revised.version.skillVersion,
          skillId: revised.version.skillId,
        });
        expect(deletion).toMatchObject({ _tag: "ApprovalRequired", change: "delete" });
        const inspected = yield* tools.inspect({
          _tag: "One",
          skillId: revised.version.skillId,
        });
        expect(inspected._tag).toBe("SkillInspection");
        if (inspected._tag === "SkillInspection") {
          expect(inspected.current.instructions).toContain("decisions");
          expect("versions" in inspected).toBe(false);
        }
        const undone = yield* tools.manage({
          _tag: "UndoLatest",
          expectedSkillVersion: revised.version.skillVersion,
          skillId: revised.version.skillId,
        });
        expect(undone._tag).toBe("RolledBack");
      }),
    ),
  );

  it("rejects an ambiguous conversational Skill change before lifecycle execution", () => {
    expect(
      Schema.is(SkillManageInput)({
        _tag: "Revise",
        instructions: "Make the reports shorter.",
      }),
    ).toBe(false);
  });

  it.effect(
    "projects safe settings, undoes lifecycle changes, and requires exact deletion Approval",
    () =>
      withDatabase((storage) =>
        Effect.gen(function* () {
          const authority = makePersonalSkillAuthority(storage);
          yield* authority.create({ availability, version: version(1) });
          const control = makePersonalSkillControl({
            authority,
            availability: () => availability,
            decisionReference: () => "settings-decision-1",
            nowEpochMillis: () => 1_788_000_000_300,
          });

          const listed = yield* control.inspect(userId);
          expect(listed.skills).toMatchObject([
            {
              availability: { state: "available" },
              behavior: "Create the weekly status report as a PDF.",
              canUndo: false,
              capabilities: ["Generate one bounded PDF or DOCX."],
              purpose: "Prepare the User's weekly status report.",
              status: "active",
            },
          ]);
          const skill = listed.skills[0];
          if (skill === undefined) return;
          const archived = yield* control.change(userId, {
            change: "archive",
            expectedRevision: skill.revisionReference,
            reference: skill.reference,
          });
          expect(archived).toMatchObject({
            notice: "Skill archived.",
            skill: { canUndo: true, status: "archived" },
          });
          const restored = yield* control.change(userId, {
            change: "undo",
            expectedRevision: archived.skill.revisionReference,
            reference: archived.skill.reference,
          });
          expect(restored).toMatchObject({
            notice: "Latest Skill change undone.",
            skill: { status: "active" },
          });

          const presentation = yield* control.presentDeletion(userId, skill.reference);
          const edited = {
            approval: {
              decision: "approved" as const,
              presentation: { ...presentation, expectedRevision: "edited-revision" },
            },
            confirmation: "delete-this-skill" as const,
          };
          expect(yield* Effect.exit(control.delete(userId, skill.reference, edited))).toMatchObject(
            { _tag: "Failure" },
          );
          yield* control.delete(userId, skill.reference, {
            approval: {
              decision: "approved",
              presentation: yield* control.presentDeletion(userId, skill.reference),
            },
            confirmation: "delete-this-skill",
          });
          expect((yield* control.inspect(userId)).skills).toEqual([]);
          expect((yield* control.inspect(UserId.make("another-user"))).skills).toEqual([]);
        }),
      ),
  );

  it.effect("deletes the initial accepted learning candidate and its model attempts", () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const authority = makePersonalSkillAuthority(storage);
        yield* authority.create({ availability, version: version(1) });
        const candidate = learningCandidate("candidate-initial-skill-delete");
        yield* authority.enqueueLearning(candidate);
        yield* authority.recordLearningCost({
          attemptId: SkillLearningModelAttemptId.make("initial-skill-delete-attempt"),
          basis: "observed",
          candidateId: candidate.candidateId,
          modelInputTokens: 10,
          modelOutputTokens: 5,
          outcome: "success",
          recordedAtEpochMillis: 1_788_000_000_250,
          userId,
          vendorUsdMicros: 2,
        });
        storage.sql.exec(
          `UPDATE osfo_personal_skill_learning_candidates
           SET accepted_skill_version = ?, status = 'accepted'
           WHERE candidate_id = ?`,
          PersonalSkillVersionId.make("weekly-status-v1"),
          candidate.candidateId,
        );

        yield* authority.delete({
          expectedSkillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
          skillId: PersonalSkillId.make("weekly-status"),
          userId,
        });

        expect(
          storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM osfo_personal_skill_learning_candidates",
            )
            .one().count,
        ).toBe(0);
        expect(
          storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM osfo_personal_skill_learning_model_attempts",
            )
            .one().count,
        ).toBe(0);
      }),
    ),
  );

  it.effect("removes Skill versions and pending learning through User deletion lineage", () =>
    withDatabase((storage) =>
      Effect.gen(function* () {
        const authority = makePersonalSkillAuthority(storage);
        yield* authority.create({ availability, version: version(1) });
        const candidate = learningCandidate("candidate-account-delete");
        yield* authority.enqueueLearning(candidate);
        const costEvidence = {
          attemptId: SkillLearningModelAttemptId.make("account-delete-attempt"),
          basis: "observed",
          candidateId: candidate.candidateId,
          modelInputTokens: 10,
          modelOutputTokens: 5,
          outcome: "success",
          recordedAtEpochMillis: 1_788_000_000_250,
          userId,
          vendorUsdMicros: 2,
        } as const;
        yield* authority.recordLearningCost(costEvidence);
        yield* authority.recordLearningCost(costEvidence);
        const deletionAssistantId = AssistantMessageId.make("assistant-account-delete");
        const deletionRequestId = ThinkRequestId.make("request-account-delete");
        const deletionSubmissionId = ThinkSubmissionId.make("submission-account-delete");
        const deletionCommit = yield* Schema.decodeEffect(CommittedTurnReceipt)({
          assistantMessageId: deletionAssistantId,
          observationSequence: 2,
          observedAt: "2026-08-27 00:00:01",
          sessionId: "session-journey",
          source: "hook",
          thinkRequestId: deletionRequestId,
        });
        const deletionMessages = journeyMessages({
          assistantMessageId: deletionAssistantId,
          requestId: deletionRequestId,
          submissionId: deletionSubmissionId,
        });
        const deletionEvaluation = yield* makeGoodRootOutcomeEvaluator({
          authority: makeGoodRootOutcomeEvaluatorAuthority(storage),
          facts: {
            readCommittedTurns: Effect.succeed([deletionCommit]),
            readMessages: () => deletionMessages,
          },
        }).evaluate({
          assistantMessageId: deletionAssistantId,
          evaluatedAtEpochMillis: 1_788_000_000_250,
        });
        expect(Option.isSome(deletionEvaluation)).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              authority.recordLearningCost({ ...costEvidence, vendorUsdMicros: 3 }),
            ),
          ),
        ).toBe(true);

        yield* authority.deleteUserData(userId);

        expect(yield* authority.active(userId)).toEqual([]);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              authority.pin({ skillId: PersonalSkillId.make("weekly-status"), userId }),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              authority.claimLearning({
                candidateId: candidate.candidateId,
                claimToken: "claim-after-account-delete",
                leaseMilliseconds: 1_000,
                nowEpochMillis: 1_788_000_000_300,
                userId,
              }),
            ),
          ),
        ).toBe(true);
        expect(
          storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM osfo_personal_skill_learning_model_attempts",
            )
            .one().count,
        ).toBe(0);
        expect(
          storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM osfo_good_root_outcome_evaluations",
            )
            .one().count,
        ).toBe(0);
      }),
    ),
  );
});

const journeyMessages = ({
  assistantMessageId,
  requestId,
  status = "completed",
  submissionId,
  terminalSubmissionId = submissionId,
}: {
  readonly assistantMessageId: AssistantMessageId;
  readonly requestId: ThinkRequestId;
  readonly status?: "aborted" | "completed" | "error";
  readonly submissionId: ThinkSubmissionId;
  readonly terminalSubmissionId?: ThinkSubmissionId;
}): ReadonlyArray<UIMessage> => {
  const turnMetadata = Schema.decodeUnknownSync(ManagedTurnMetadata)({
    _tag: "OsfoManagedTurn",
    allowancePeriodId: "allowance-journey",
    authorityIdentity: {
      _tag: "AuthSession",
      authSessionId: "auth-session-journey",
      userId,
    },
    capabilityCatalogVersion: "governed-capabilities-v1",
    capabilityTurnState: {
      eligiblePersonalSkills: [],
      initialized: true,
      loadedSkillReceipts: [],
      pendingFileAnalyses: [],
      skillLearningDraft: {
        availableCapabilityIds: ["document-generation"],
        availableRequirements: ["personal-agent"],
        origin: "authSession",
        ownerUserId: userId,
        priorSkillId: null,
        priorSkillVersion: null,
        submissionId,
        taskDescription: "Always put the summary first in every weekly report.",
      },
    },
    conservativeVendorUsdMicros: 100,
    coreMemoryAuthorization: {
      authority: {
        _tag: "AuthSession",
        authSessionId: "auth-session-journey",
        expiresAt: "2026-08-27T13:00:00.000Z",
        userId,
      },
      deletionAccess: { _tag: "DeletionAccessAvailable" },
      now: "2026-08-27T12:00:00.000Z",
      originatingAuthority: { _tag: "AuthSession", authSessionId: "auth-session-journey" },
      resourceOwnerUserId: userId,
      subscription: { plan: "free", planPolicyVersion: "launch-v1" },
      user: { _tag: "ActiveUser", userId },
    },
    maxInputTokens: 32_000,
    maxOutputTokens: 4_096,
    maxRetries: 0,
    maxSteps: 5,
    originatingAuthority: { _tag: "AuthSession", authSessionId: "auth-session-journey" },
    plan: "free",
    planPolicyVersion: "launch-v1",
    route: "@cf/test/model",
    routeId: "route-journey",
    sessionId: "session-journey",
    submissionId,
    targetInputTokens: 18_000,
  });
  const terminal = CommittedTurnTerminal.make({
    attribution: {
      allowancePeriodId: turnMetadata.allowancePeriodId,
      executionMode: "normalPlanUsage",
      sessionId: turnMetadata.sessionId,
      userId,
    },
    requestId,
    status,
    submissionId: terminalSubmissionId,
  });
  return [
    {
      id: `user-${submissionId}`,
      metadata: { turnMetadata },
      parts: [{ text: "Always put the summary first in every weekly report.", type: "text" }],
      role: "user",
    },
    {
      id: assistantMessageId,
      metadata: withCommittedTurnTerminal({}, terminal),
      parts: [{ text: "The report is ready.", type: "text" }],
      role: "assistant",
    },
  ];
};

const withDatabase = <A, E>(
  use: (storage: PersonalSkillAuthorityStorage) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const database = new DatabaseSync(":memory:");
      database.exec("PRAGMA foreign_keys = ON");
      database.exec(`CREATE TABLE osfo_personal_skills (
        skill_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        current_revision INTEGER NOT NULL CHECK (current_revision > 0),
        current_skill_version TEXT NOT NULL UNIQUE,
        last_used_at_epoch_millis INTEGER,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived'))
      ) STRICT`);
      database.exec(`CREATE TABLE osfo_personal_skill_versions (
        skill_id TEXT NOT NULL REFERENCES osfo_personal_skills(skill_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        skill_version TEXT NOT NULL UNIQUE,
        version_json TEXT NOT NULL,
        PRIMARY KEY (skill_id, revision)
      ) STRICT`);
      database.exec(`CREATE TABLE osfo_personal_skill_learning_candidates (
        accepted_skill_version TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        candidate_id TEXT PRIMARY KEY,
        candidate_json TEXT NOT NULL,
        claim_expires_at_epoch_millis INTEGER,
        claim_token TEXT,
        created_at_epoch_millis INTEGER NOT NULL,
        notification_delivered_at_epoch_millis INTEGER,
        notification_text TEXT,
        owner_user_id TEXT NOT NULL,
        prior_skill_version TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'accepted', 'rejected')),
        undo_target_skill_version TEXT,
        updated_at_epoch_millis INTEGER NOT NULL
      ) STRICT`);
      database.exec(`CREATE TABLE osfo_personal_skill_learning_model_attempts (
        attempt_id TEXT PRIMARY KEY,
        basis TEXT NOT NULL CHECK (basis IN ('conservative', 'observed')),
        candidate_id TEXT NOT NULL,
        model_input_tokens INTEGER NOT NULL CHECK (model_input_tokens >= 0),
        model_output_tokens INTEGER NOT NULL CHECK (model_output_tokens >= 0),
        outcome TEXT NOT NULL CHECK (outcome IN ('failure', 'success')),
        recorded_at_epoch_millis INTEGER NOT NULL,
        vendor_usd_micros INTEGER NOT NULL CHECK (vendor_usd_micros >= 0)
      ) STRICT`);
      database.exec(`CREATE TABLE osfo_good_root_outcome_evaluations (
        evaluation_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        retained_at_epoch_millis INTEGER NOT NULL
      ) STRICT`);
      return { database, storage: nodeStorage(database) };
    }),
    ({ storage }) => use(storage),
    ({ database }) => Effect.sync(() => database.close()),
  );

const nodeStorage = (database: DatabaseSync): PersonalSkillAuthorityStorage => ({
  sql: {
    exec: <T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: Array<SqlStorageValue>
    ): SqlStorageCursor<T> => {
      const statement = database.prepare(query);
      const rows = statement.all(...bindings.map(toNodeBinding)).map(normalizeRow);
      // SAFETY: normalizeRow maps node:sqlite's closed row union to SqlStorageValue.
      return new NodeSqlCursor(
        rows as Array<T>,
        statement.columns().map(({ name }) => name),
      );
    },
  },
  transactionSync: <A>(transaction: () => A): A => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = transaction();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  },
});

class NodeSqlCursor<T extends Record<string, SqlStorageValue>> implements SqlStorageCursor<T> {
  readonly columnNames: Array<string>;
  readonly rowsRead: number;
  readonly rowsWritten = 0;
  readonly #rows: Array<T>;

  constructor(rows: Array<T>, columnNames: Array<string>) {
    this.#rows = rows;
    this.columnNames = columnNames;
    this.rowsRead = rows.length;
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.#rows.values();
  }

  next(): { done?: false; value: T } | { done: true; value?: never } {
    const result = this.#rows.values().next();
    return result.done ? { done: true } : { done: false, value: result.value };
  }

  one(): T {
    const [only, ...remaining] = this.#rows;
    if (only === undefined || remaining.length > 0) throw new Error("Expected exactly one row");
    return only;
  }

  raw<U extends Array<SqlStorageValue>>(): IterableIterator<U> {
    // SAFETY: tuples follow columnNames and contain only normalized SqlStorageValue values.
    return this.#rows.map((row) => this.columnNames.map((name) => row[name]) as U).values();
  }

  toArray(): Array<T> {
    return [...this.#rows];
  }
}

const normalizeRow = (row: Record<string, SQLOutputValue>): Record<string, SqlStorageValue> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array
        ? value.slice().buffer
        : typeof value === "bigint"
          ? Number(value)
          : value,
    ]),
  );

const toNodeBinding = (value: SqlStorageValue): SQLInputValue =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : value;
