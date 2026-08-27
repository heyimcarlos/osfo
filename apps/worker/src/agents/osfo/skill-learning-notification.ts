import type { UIMessage } from "ai";
import { Effect, Option, Schema } from "effect";

import type {
  MarkSkillLearningNotificationDeliveredInput,
  PendingSkillLearningNotification,
} from "./personal-skill-authority";

/** History and authority ports for crash-recoverable personal Skill notices. */
export interface SkillLearningNotificationDelivery<Error> {
  readonly markDelivered: (
    input: MarkSkillLearningNotificationDeliveredInput,
  ) => Effect.Effect<void, Error>;
  readonly messages: () => ReadonlyArray<UIMessage>;
  readonly nowEpochMillis: () => number;
  readonly pending: Effect.Effect<ReadonlyArray<PendingSkillLearningNotification>, Error>;
  readonly updateMessage: (message: UIMessage) => Effect.Effect<void, Error>;
}

/** Deliver each retained notice exactly once from the User-visible message history. */
export const deliverSkillLearningNotifications = Effect.fn(
  "SkillLearningNotificationDelivery.deliver",
)(function* <Error>(delivery: SkillLearningNotificationDelivery<Error>) {
  const pending = yield* delivery.pending;
  for (const notification of pending) {
    const message = delivery
      .messages()
      .find(({ id }) => id === notification.candidate.rootAssistantMessageId);
    if (message === undefined) continue;
    const alreadyDelivered = message.parts.some(
      (part) => part.type === "text" && part.text === notification.notification,
    );
    if (!alreadyDelivered) {
      yield* delivery.updateMessage({
        ...message,
        metadata: {
          ...Option.getOrElse(
            Schema.decodeUnknownOption(Schema.JsonObject)(message.metadata),
            () => ({}),
          ),
          osfoPersonalSkillChange: {
            skillId: notification.version.skillId,
            skillVersion: notification.version.skillVersion,
            undoTargetSkillVersion: notification.undoTargetSkillVersion,
          },
        },
        parts: [...message.parts, { text: notification.notification, type: "text" }],
      });
    }
    yield* delivery.markDelivered({
      candidateId: notification.candidate.candidateId,
      deliveredAtEpochMillis: delivery.nowEpochMillis(),
      skillVersion: notification.version.skillVersion,
      userId: notification.candidate.ownerUserId,
    });
  }
});

export * as SkillLearningNotification from "./skill-learning-notification";
