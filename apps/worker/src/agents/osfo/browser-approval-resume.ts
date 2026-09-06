/* oxlint-disable effecttsgo/async-function -- This module owns Durable Object Promise and transaction callbacks. */
import { Effect, Schema } from "effect";
import {
  AgentId,
  ChannelLinkId,
  ConversationRouteId,
  SessionId,
  ThinkSubmissionId,
  UserId,
} from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { BrowserEffectInput } from "./browser-task";
import { ActionPresentationId } from "./think-action-approvals";

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const MessengerOrigin = Schema.Struct({
  messenger: Schema.Struct({
    messengerId: Schema.Literals(["telegram", "whatsapp"]),
    provider: Schema.Literals(["telegram", "whatsapp"]),
    capabilities: Schema.Struct({}),
    kind: Schema.Literals(["direct-message", "mention", "subscribed-message"]),
    thread: Schema.Struct({ id: text, providerThreadId: text, isDirectMessage: Schema.Boolean }),
    message: Schema.Struct({
      id: text,
      providerMessageId: text,
      author: Schema.Struct({ userId: text }),
      text: Schema.String,
      attachments: Schema.Array(Schema.Struct({})),
    }),
  }),
});
export const Origin = Schema.Struct({
  actionId: ActionId,
  channelLinkId: ChannelLinkId,
  routeId: ConversationRouteId,
  sessionId: SessionId,
  submissionId: ThinkSubmissionId,
  userId: UserId,
  messenger: MessengerOrigin.fields.messenger,
  input: BrowserEffectInput,
});
export type Origin = typeof Origin.Type;
export const Reply = Schema.Struct({
  agentId: AgentId,
  origin: Origin,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
});
export type Reply = typeof Reply.Type;

export const Decision = Schema.Struct({
  origin: Origin,
  presentationId: ActionPresentationId,
  decision: Schema.Literals(["approve", "reject"]),
  outcome: Schema.Unknown,
  settled: Schema.Boolean,
});
export type Decision = typeof Decision.Type;
export const Delivery = Schema.Struct({
  actionId: ActionId,
  stage: Schema.Literals(["pending", "sending", "completed"]),
  settled: Schema.Boolean,
});
export type Delivery = typeof Delivery.Type;
/** Pending native approval is not an uncertain consumed effect and must not start a continuation. */
export const followUpKey = (decision: Decision, nativePending: boolean) =>
  !decision.settled && nativePending
    ? null
    : `browser-approval-reply:${decision.origin.actionId}:${decision.settled ? "settled" : "unknown"}`;

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "BrowserApprovalResumeUnavailable",
  {
    cause: Schema.Defect(),
  },
) {}

/** Browser-only correlation; native Think retains the Action and delivery Fiber ledgers. */
export const make = (storage: DurableObjectStorage) => {
  const read = <S extends Schema.Top>(key: string, schema: S) =>
    Effect.tryPromise({
      try: () => storage.get(key),
      catch: (cause) => new Unavailable({ cause }),
    }).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(schema)(value)),
      Effect.mapError((cause) => new Unavailable({ cause })),
    );
  const put = (key: string, value: typeof Decision.Encoded) =>
    Effect.tryPromise({
      try: () => storage.put(key, value),
      catch: (cause) => new Unavailable({ cause }),
    });
  return {
    retainOrigin: (origin: Origin) =>
      Effect.tryPromise({
        try: () =>
          storage.transaction(async (transaction) => {
            const key = `browser-approval-origin:${origin.actionId}`;
            const retained = await transaction.get(key);
            if (
              retained !== undefined &&
              !Schema.toEquivalence(Origin)(Schema.decodeUnknownSync(Origin)(retained), origin)
            )
              throw new Error("Browser approval origin cannot change.");
            if (retained === undefined)
              await transaction.put(key, Schema.encodeSync(Origin)(origin));
          }),
        catch: (cause) => new Unavailable({ cause }),
      }),
    origin: (actionId: ActionId) => read(`browser-approval-origin:${actionId}`, Origin),
    retainDecision: (decision: Decision) =>
      put(
        `browser-approval-decision:${decision.origin.actionId}`,
        Schema.encodeSync(Decision)(decision),
      ),
    decision: (actionId: ActionId) => read(`browser-approval-decision:${actionId}`, Decision),
    forget: (actionId: ActionId) =>
      Effect.tryPromise({
        try: () =>
          storage.delete([
            `browser-approval-decision:${actionId}`,
            `browser-approval-origin:${actionId}`,
          ]),
        catch: (cause) => new Unavailable({ cause }),
      }),
    pruneOrigins: (retained: ReadonlySet<string>) =>
      Effect.tryPromise({
        try: async () => {
          const rows = await storage.list({ prefix: "browser-approval-origin:", limit: 100 });
          const expired = [...rows.keys()].filter(
            (key) => !retained.has(key.slice("browser-approval-origin:".length)),
          );
          if (expired.length > 0) await storage.delete(expired);
        },
        catch: (cause) => new Unavailable({ cause }),
      }),
    pending: () =>
      Effect.tryPromise({
        try: () => storage.list({ prefix: "browser-approval-decision:" }),
        catch: (cause) => new Unavailable({ cause }),
      }).pipe(
        Effect.flatMap((rows) =>
          Schema.decodeUnknownEffect(Schema.Array(Decision))([...rows.values()]),
        ),
        Effect.mapError((cause) => new Unavailable({ cause })),
      ),
  };
};

/** An internal continuation describes retained facts; it never impersonates new User intent. */
export const instruction = (decision: Decision) =>
  !decision.settled
    ? `The browser approval outcome is unresolved. Do not repeat or continue browser effects. Explain that the result is unknown. Browser task: ${decision.origin.input.taskId}.`
    : decision.decision === "reject"
      ? `The User rejected the pending browser action. Do not execute, recreate, or propose that interaction again. Send a brief no-effect confirmation in their chat. Browser task: ${decision.origin.input.taskId}. Native outcome: ${JSON.stringify(decision.outcome)}`
      : `Continue the existing browser task within the User's retained preferences. The User approved one action; approval alone is not proof of success. Inspect the retained native outcome and current browser result before stating what happened. Any further side effect requires its own approval. Browser task: ${decision.origin.input.taskId}. Native outcome: ${JSON.stringify(decision.outcome)}`;

export * as BrowserApprovalResume from "./browser-approval-resume";
