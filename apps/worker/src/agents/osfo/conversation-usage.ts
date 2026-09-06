import type { UIMessage } from "ai";
import type { CommittedTurnTerminal } from "./committed-turn-terminal";
import { Effect, Option, Result, Schema } from "effect";

import {
  ModelAccessPolicyVersion,
  ResourcePriceVersion,
  type ThinkSubmissionId,
} from "../../domain";
import { ManagedTurnMetadata } from "../../domain/managed-conversation";
import { retainedCatalog } from "../../domain/plan-policy";
import {
  managedConversationModelPrice,
  rate,
  type CompletedNonModelCost,
} from "../../domain/usage";
import { UsageEvent } from "../../domain/usage-event";
import type { PaidSearchAttempt } from "../../services/web";

const quantity = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ConversationModelStep = Schema.Struct({
  gatewayLogId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  ),
  cachedInputTokens: Schema.NullOr(quantity),
  inputTokens: Schema.NullOr(quantity),
  outputTokens: Schema.NullOr(quantity),
  stepNumber: Schema.Int.check(Schema.isGreaterThan(0)),
}).check(
  Schema.makeFilter(
    (step) =>
      step.cachedInputTokens === null ||
      step.inputTokens === null ||
      step.cachedInputTokens <= step.inputTokens,
  ),
);
export type ConversationModelStep = typeof ConversationModelStep.Type;
const encodeStep = Schema.encodeSync(Schema.fromJsonString(ConversationModelStep));
const ModelSteps = Schema.Struct({
  osfoConversationModelSteps: Schema.Array(ConversationModelStep),
});
const Turn = Schema.Struct({ turnMetadata: ManagedTurnMetadata });
const StoredEvent = Schema.fromJsonString(Schema.toCodecJson(UsageEvent));
export const encodeConversationUsage = Schema.encodeSync(StoredEvent);
export const decodeConversationUsage = Schema.decodeUnknownEffect(StoredEvent);

export class ConversationUsageUnavailable extends Schema.TaggedError<ConversationUsageUnavailable>()(
  "ConversationUsageUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    reason: Schema.optionalKey(Schema.Literal("unreported")),
  },
) {}

/** Keep exact token evidence on the existing Submission message before recording gateway cost. */
export const retainConversationModelStep = (
  messages: ReadonlyArray<UIMessage>,
  submissionId: ThinkSubmissionId,
  step: ConversationModelStep,
): Effect.Effect<UIMessage, ConversationUsageUnavailable> =>
  Effect.gen(function* () {
    const message = submissionMessage(messages, submissionId);
    if (message === undefined)
      return yield* unavailable("The model step has no retained Submission");
    const metadata = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(message.metadata).pipe(
      Effect.mapError((cause) => unavailable("Submission metadata is invalid", cause)),
    );
    const steps =
      "osfoConversationModelSteps" in metadata
        ? yield* Schema.decodeUnknownEffect(ModelSteps)(metadata).pipe(
            Effect.map(({ osfoConversationModelSteps }) => osfoConversationModelSteps),
            Effect.mapError((cause) => unavailable("Retained model steps are invalid", cause)),
          )
        : [];
    const existing = steps.find((candidate) => candidate.stepNumber === step.stepNumber);
    if (existing !== undefined && encodeStep(existing) !== encodeStep(step)) {
      return yield* unavailable("A model step already has different token evidence");
    }
    return {
      ...message,
      metadata: {
        ...metadata,
        osfoConversationModelSteps: existing === undefined ? [...steps, step] : steps,
      },
    };
  });

export interface CompletedConversationSearch {
  readonly operationId: string;
  readonly attempt: PaidSearchAttempt;
}

/** Finalize all completed model/search facts once under the original Submission authority. */
export const conversationUsageEvent = (
  messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly metadata?: unknown;
  }>,
  metadata: ManagedTurnMetadata,
  searches: ReadonlyArray<CompletedConversationSearch>,
  occurredAt: Date,
): Effect.Effect<UsageEvent, ConversationUsageUnavailable> =>
  Effect.gen(function* () {
    const message = submissionMessage(messages, metadata.submissionId);
    const retained = yield* Schema.decodeUnknownEffect(ModelSteps)(message?.metadata).pipe(
      Effect.mapError((cause) =>
        unreported("Completed conversation has no exact model usage", cause),
      ),
    );
    // oxlint-disable-next-line unicorn/no-array-sort -- The Worker target lacks toSorted; only this fresh copy is mutated.
    const steps = [...retained.osfoConversationModelSteps].sort(
      (a, b) => a.stepNumber - b.stepNumber,
    );
    if (steps.length === 0 || steps.some((step, index) => step.stepNumber !== index + 1)) {
      return yield* unreported("Completed conversation model evidence is incomplete");
    }
    if (
      metadata.route !== "@cf/deepseek-ai/deepseek-v4-flash-0731" ||
      metadata.conversationResourcePriceVersion !==
        managedConversationModelPrice.resourcePriceVersion
    ) {
      return yield* unreported("The admitted conversation has no retained model price");
    }
    const nonModel: Array<CompletedNonModelCost> = [];
    for (const search of searches) {
      const { admission, evidence } = search.attempt;
      if (
        admission.allowancePeriodId !== metadata.allowancePeriodId ||
        admission.planPolicyVersion !== metadata.planPolicyVersion ||
        evidence.ratedCostUsdMicros === null
      ) {
        return yield* unavailable(
          "Completed search does not match the conversation accounting authority",
        );
      }
      if (evidence.ratedCostUsdMicros > 0) {
        nonModel.push({
          activity: "webAndResearch",
          ratedCostUsdMicros: BigInt(evidence.ratedCostUsdMicros),
          resourcePriceVersion: ResourcePriceVersion.make(evidence.resourcePriceVersion),
        });
      }
    }
    const modelWork = yield* Effect.forEach(steps, (step) => {
      if (
        step.cachedInputTokens === null ||
        step.inputTokens === null ||
        step.inputTokens === 0 ||
        step.outputTokens === null
      ) {
        return Effect.fail(
          unreported(
            "Completed model token usage is unreported; Plan Usage settlement remains pending",
          ),
        );
      }
      return Effect.succeed({
        activity: "conversationsAndMemory" as const,
        cachedInputTokens: BigInt(step.cachedInputTokens),
        inputTokens: BigInt(step.inputTokens),
        outputTokens: BigInt(step.outputTokens),
        price: managedConversationModelPrice,
      });
    });
    const rated = rate(modelWork, nonModel, retainedCatalog, metadata.planPolicyVersion);
    if (Result.isFailure(rated))
      return yield* unavailable("Completed conversation could not be rated", rated.failure);
    return {
      allowancePeriodId: metadata.allowancePeriodId,
      capabilityCatalogVersion: metadata.capabilityCatalogVersion,
      evidenceReferences: [
        ...steps.map((step) => ({
          kind: "operationEvidence" as const,
          reference: `model-call-attempt:${metadata.submissionId}:${step.stepNumber}`,
        })),
        ...steps.flatMap((step) =>
          step.gatewayLogId === undefined
            ? []
            : [{ kind: "gatewayLog" as const, reference: step.gatewayLogId }],
        ),
        ...searches.map((search) => ({
          kind: "operationEvidence" as const,
          reference: search.operationId,
        })),
      ],
      manifestVersion: null,
      modelAccessPolicyVersion: ModelAccessPolicyVersion.make(metadata.planPolicyVersion),
      occurredAt,
      outcome: { _tag: "Completed", charge: rated.success },
      rootOperationId: metadata.submissionId,
      source: { sourceId: metadata.submissionId, sourceType: "conversation" },
      usagePolicyVersion: metadata.planPolicyVersion,
    };
  });

const submissionMessage = <
  Message extends { readonly id: string; readonly role: string; readonly metadata?: unknown },
>(
  messages: ReadonlyArray<Message>,
  submissionId: ThinkSubmissionId,
) =>
  messages.find(
    (message) =>
      message.role === "user" &&
      Option.exists(
        Schema.decodeUnknownOption(Turn)(message.metadata),
        ({ turnMetadata }) => turnMetadata.submissionId === submissionId,
      ),
  );
// oxlint-disable-next-line osfo/no-unknown-parameters -- Retains typed boundary failures without narrowing away their cause.
const unavailable = (message: string, cause: unknown = new Error(message)) =>
  new ConversationUsageUnavailable({ cause, message });

/** Freeze the event before cross-store dispatch; lost acknowledgements replay the same event. */
export const settleConversationUsage = <
  ReadError,
  PrepareError,
  RetainError,
  DispatchError,
>(options: {
  readonly read: Effect.Effect<CommittedTurnTerminal, ReadError>;
  readonly prepare: (terminal: CommittedTurnTerminal) => Effect.Effect<UsageEvent, PrepareError>;
  readonly retain: (terminal: CommittedTurnTerminal) => Effect.Effect<void, RetainError>;
  readonly dispatch: (event: UsageEvent) => Effect.Effect<void, DispatchError>;
}) =>
  Effect.gen(function* () {
    const terminal: CommittedTurnTerminal = yield* options.read;
    if (
      terminal.status !== "completed" ||
      terminal.usageOccurredAt === undefined ||
      terminal.usageSettled === true
    )
      return;
    const event =
      terminal.usageEventJson === undefined
        ? yield* options.prepare(terminal)
        : yield* decodeConversationUsage(terminal.usageEventJson);
    // oxlint-disable-next-line typescript/no-misused-spread -- CommittedTurnTerminal is a Schema.Struct record with no prototype behavior.
    const frozen = { ...terminal, usageEventJson: encodeConversationUsage(event) };
    if (terminal.usageEventJson === undefined) yield* options.retain(frozen);
    yield* options.dispatch(event);
    yield* options.retain({ ...frozen, usageSettled: true });
  });

// oxlint-disable-next-line osfo/no-unknown-parameters -- Preserve the provider evidence failure at its owning decoder.
const unreported = (message: string, cause: unknown = new Error(message)) =>
  new ConversationUsageUnavailable({ cause, message, reason: "unreported" });

/** A Session may discard unknown Company Cost evidence, but never an unacknowledged User charge. */
export const settleBeforeClearingSession = <E>(
  settlements: ReadonlyArray<Effect.Effect<void, ConversationUsageUnavailable>>,
  clear: Effect.Effect<void, E>,
) =>
  Effect.forEach(
    settlements,
    (settlement) =>
      settlement.pipe(
        Effect.catchTag("ConversationUsageUnavailable", (failure) =>
          failure.reason === "unreported"
            ? Effect.logWarning("Session deletion leaves unreported model usage uncharged").pipe(
                Effect.annotateLogs({ failure }),
              )
            : Effect.fail(failure),
        ),
      ),
    { concurrency: 1, discard: true },
  ).pipe(Effect.andThen(clear));
