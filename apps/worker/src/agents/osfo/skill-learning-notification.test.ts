/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
/* oxlint-disable typescript/no-misused-spread -- The test simulates durable UI history replacement. */

import type { UIMessage } from "ai";
import { expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { AssistantMessageId, UserId } from "../../domain";
import {
  PersonalSkillId,
  PersonalSkillVersionId,
  SkillLearningCandidateId,
} from "../../domain/personal-skill";
import type { PendingSkillLearningNotification } from "./personal-skill-authority";
import { deliverSkillLearningNotifications } from "./skill-learning-notification";

it.effect(
  "recovers a material Skill notice after a crash without duplicating visible history",
  () =>
    Effect.gen(function* () {
      const messages: Array<UIMessage> = [
        {
          id: "assistant-notice",
          parts: [{ text: "Your report is ready.", type: "text" }],
          role: "assistant",
        },
      ];
      const notification = pendingNotification();
      let marks = 0;
      let updates = 0;
      const delivery = {
        markDelivered: () =>
          Effect.sync(() => {
            marks += 1;
          }),
        messages: () => messages,
        nowEpochMillis: () => 1_788_000_000_200,
        pending: Effect.succeed([notification]),
        updateMessage: (message: UIMessage) =>
          Effect.sync(() => {
            updates += 1;
            messages[0] = message;
          }),
      };
      const crashed = yield* Effect.exit(
        deliverSkillLearningNotifications({
          ...delivery,
          updateMessage: () => Effect.fail("simulated history crash"),
        }),
      );
      expect(Exit.isFailure(crashed)).toBe(true);
      expect(marks).toBe(0);

      yield* deliverSkillLearningNotifications(delivery);
      yield* deliverSkillLearningNotifications(delivery);

      expect(updates).toBe(1);
      expect(marks).toBe(2);
      expect(messages[0]?.parts).toContainEqual({
        text: notification.notification,
        type: "text",
      });
      expect(messages[0]?.metadata).toMatchObject({
        osfoPersonalSkillChange: {
          skillId: "weekly-status",
          skillVersion: "weekly-status-v2",
          undoTargetSkillVersion: "weekly-status-v1",
        },
      });
    }),
);

const pendingNotification = (): PendingSkillLearningNotification => ({
  candidate: {
    availableCapabilityIds: ["document-generation"],
    availableRequirements: ["document-renderer"],
    candidateBytes: 200n,
    candidateId: SkillLearningCandidateId.make("candidate-notice"),
    corrections: ["Going forward, put the summary first."],
    createdAtEpochMillis: 1_788_000_000_000,
    decisions: [],
    evidence: [
      { _tag: "ExplicitUserCorrection", referenceId: "correction-notice" },
      { _tag: "ConfirmedRootOutcome", referenceId: "good-root-notice" },
    ],
    ownerUserId: UserId.make("user-1"),
    priorSkillId: PersonalSkillId.make("weekly-status"),
    priorSkillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
    rootAssistantMessageId: AssistantMessageId.make("assistant-notice"),
    rootOutcomeReferenceId: "good-root-notice",
    taskDescription: "Create the weekly status report.",
  },
  notification: "I learned a weekly status report procedure. You can ask me to undo it.",
  undoTargetSkillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
  version: {
    allowedOrigins: ["channelLink"],
    capabilityIds: ["document-generation"],
    createdAtEpochMillis: 1_788_000_000_000,
    createdBy: "learning",
    creationEvidence: [
      { _tag: "ExplicitUserCorrection", referenceId: "correction-notice" },
      { _tag: "ConfirmedRootOutcome", referenceId: "good-root-notice" },
    ],
    description: "Prepare the User's weekly status report.",
    instructions: "Put the summary first.",
    keywords: ["weekly status"],
    lastUsedAtEpochMillis: null,
    origin: "learned",
    outcomeFacts: { confirmedFailures: 0, confirmedSuccesses: 2 },
    ownerUserId: UserId.make("user-1"),
    parentSkillVersion: PersonalSkillVersionId.make("weekly-status-v1"),
    requirements: ["document-renderer"],
    revision: 2,
    skillId: PersonalSkillId.make("weekly-status"),
    skillVersion: PersonalSkillVersionId.make("weekly-status-v2"),
    status: "active",
    taskDescription: "Create the weekly status report.",
    taskKinds: ["document"],
    updatedAtEpochMillis: 1_788_000_000_100,
    updateEvidence: [
      { _tag: "ExplicitUserCorrection", referenceId: "correction-notice" },
      { _tag: "ConfirmedRootOutcome", referenceId: "good-root-notice" },
    ],
  },
});
