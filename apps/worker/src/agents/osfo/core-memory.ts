import { action, type Session } from "@cloudflare/think";
import {
  AgentContextProvider,
  type ContextBlock,
  type SqlProvider,
} from "agents/experimental/memory/session";
import { estimateStringTokens } from "agents/experimental/memory/utils";
import { Effect, Option, Schema } from "effect";

import { ActionId } from "../../domain/action-execution";
import {
  ActionPresentation,
  ActionPresentationId,
  ActionPresentationUnavailable,
  type PendingThinkAction,
} from "./think-action-approvals";

const userContextLabel = "User Context";
const agentNotesLabel = "Agent Notes";
const userContextMaxTokens = 1_200;
const agentNotesMaxTokens = 800;
const positiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));
const configurableTokenBudget = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(8_000),
);
const coreMemoryClearAction = "osfoClearCoreMemory";

/** The two independently managed Core Memory blocks. */
export const CoreMemoryBlockName = Schema.Literals(["userContext", "agentNotes"]);

/** The two independently managed Core Memory blocks. */
export type CoreMemoryBlockName = typeof CoreMemoryBlockName.Type;

/** Direct User correction that replaces the complete selected block. */
export const CorrectCoreMemoryInput = Schema.Struct({
  block: CoreMemoryBlockName,
  content: Schema.String.check(Schema.isMaxLength(10_000)),
});

/** Parsed direct User correction for one Core Memory block. */
export type CorrectCoreMemoryInput = typeof CorrectCoreMemoryInput.Type;

/** RPC representation of a direct User correction. */
export type CorrectCoreMemoryEncoded = typeof CorrectCoreMemoryInput.Encoded;

/** User-selected finite budget for one Core Memory block. */
export const BoundCoreMemoryInput = Schema.Struct({
  block: CoreMemoryBlockName,
  maxTokens: configurableTokenBudget,
});

/** Parsed User-selected Core Memory budget. */
export type BoundCoreMemoryInput = typeof BoundCoreMemoryInput.Type;

/** RPC representation of one User-selected Core Memory budget. */
export type BoundCoreMemoryEncoded = typeof BoundCoreMemoryInput.Encoded;

/** Exact-approved destructive clearing request for one Core Memory block. */
export const ClearCoreMemoryInput = Schema.Struct({
  block: CoreMemoryBlockName,
});

/** Parsed selection of one Core Memory block to clear. */
export type ClearCoreMemoryInput = typeof ClearCoreMemoryInput.Type;

/** RPC representation of one Core Memory block selection. */
export type ClearCoreMemoryEncoded = typeof ClearCoreMemoryInput.Encoded;

/** Expected failure when Think cannot read or write Agent-wide Core Memory. */
export class CoreMemoryUnavailable extends Schema.TaggedError<CoreMemoryUnavailable>()(
  "CoreMemoryUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["inspect", "correct", "bound", "clear"]),
  },
) {}

/** Expected rejection when one block would exceed its independent budget. */
export class CoreMemoryBudgetExceeded extends Schema.TaggedError<CoreMemoryBudgetExceeded>()(
  "CoreMemoryBudgetExceeded",
  {
    block: CoreMemoryBlockName,
    maxTokens: positiveInteger,
    message: Schema.String,
    tokens: positiveInteger,
  },
) {}

/** One user-readable Core Memory block with its independent budget use. */
export interface CoreMemoryBlockInspection {
  readonly content: string;
  readonly maxTokens: number;
  readonly tokens: number;
}

/** Agent-wide Core Memory returned through the inspection seam. */
export interface CoreMemoryInspected {
  readonly _tag: "CoreMemoryInspected";
  readonly agentNotes: CoreMemoryBlockInspection;
  readonly userContext: CoreMemoryBlockInspection;
}

/** Successful immediate replacement of one Core Memory block. */
export interface CoreMemoryCorrected {
  readonly _tag: "CoreMemoryCorrected";
  readonly block: CoreMemoryBlockName;
  readonly content: string;
  readonly maxTokens: number;
  readonly tokens: number;
}

/** Successful clearing of one Core Memory block. */
export interface CoreMemoryCleared {
  readonly _tag: "CoreMemoryCleared";
  readonly block: CoreMemoryBlockName;
}

/** Successful update of one Core Memory block's independent budget. */
export interface CoreMemoryBound {
  readonly _tag: "CoreMemoryBound";
  readonly block: CoreMemoryBlockName;
  readonly maxTokens: number;
}

/** Add Agent-wide User Context and Agent Notes to one Think Session view. */
export const configureCoreMemory = (session: Session, sqlProvider: SqlProvider): Promise<Session> =>
  Promise.all([readBudget(sqlProvider, "userContext"), readBudget(sqlProvider, "agentNotes")]).then(
    ([userContextBudget, agentNotesBudget]) =>
      session
        .withContext(userContextLabel, {
          description:
            "Proactively keep only narrow durable User facts and useful inferences. Sensitive or high-impact health, religion, politics, sexuality, legal-status, or financial-condition inferences require strong direct evidence or User confirmation. Apply a current User correction immediately. Never store hidden reasoning, chain-of-thought, a transcript, or situational explanatory baggage.",
          maxTokens: userContextBudget,
          provider: contentProvider(sqlProvider, "userContext"),
        })
        .withContext(agentNotesLabel, {
          description:
            "Proactively keep current goals, commitments, environment facts, workflow facts, and continuity useful across Sessions. Store the narrowest durable conclusion. Never store hidden reasoning, chain-of-thought, a task log, or a Session transcript.",
          maxTokens: agentNotesBudget,
          provider: contentProvider(sqlProvider, "agentNotes"),
        }),
  );

/** Inspect both user-readable Core Memory blocks through Think's public Session interface. */
export const inspectCoreMemory = (
  session: Session,
): Effect.Effect<CoreMemoryInspected, CoreMemoryUnavailable> =>
  Effect.tryPromise({
    try: () =>
      session.refreshSystemPrompt().then(() => {
        const userContext = requireBlock(session, userContextLabel);
        const agentNotes = requireBlock(session, agentNotesLabel);
        return {
          _tag: "CoreMemoryInspected",
          agentNotes: inspectBlock(agentNotes),
          userContext: inspectBlock(userContext),
        } as const;
      }),
    catch: (cause) =>
      new CoreMemoryUnavailable({
        cause,
        message: "Core Memory could not be inspected",
        operation: "inspect",
      }),
  });

/** Replace one Core Memory block from a direct User correction. */
export const correctCoreMemory = (
  session: Session,
  input: CorrectCoreMemoryInput,
): Effect.Effect<CoreMemoryCorrected, CoreMemoryBudgetExceeded | CoreMemoryUnavailable> =>
  Effect.gen(function* () {
    const memory = yield* inspectCoreMemory(session);
    const maxTokens = memory[input.block].maxTokens;
    const tokens = estimateStringTokens(input.content);
    if (tokens > maxTokens) {
      return yield* new CoreMemoryBudgetExceeded({
        block: input.block,
        maxTokens,
        message: "The Core Memory correction exceeds the selected block budget",
        tokens,
      });
    }
    return yield* Effect.tryPromise({
      try: () =>
        session
          .replaceContextBlock(labelFor(input.block), input.content)
          .then(() => session.refreshSystemPrompt())
          .then(
            () =>
              ({
                _tag: "CoreMemoryCorrected",
                block: input.block,
                content: input.content,
                maxTokens,
                tokens,
              }) as const,
          ),
      catch: (cause) =>
        new CoreMemoryUnavailable({
          cause,
          message: "Core Memory could not be corrected",
          operation: "correct",
        }),
    });
  });

/** Persist one User-selected block budget when its current content fits. */
export const boundCoreMemory = (
  session: Session,
  sqlProvider: SqlProvider,
  input: BoundCoreMemoryInput,
): Effect.Effect<CoreMemoryBound, CoreMemoryBudgetExceeded | CoreMemoryUnavailable> =>
  Effect.gen(function* () {
    const memory = yield* inspectCoreMemory(session);
    const tokens = memory[input.block].tokens;
    if (tokens > input.maxTokens) {
      return yield* new CoreMemoryBudgetExceeded({
        block: input.block,
        maxTokens: input.maxTokens,
        message: "The current Core Memory content exceeds the requested block budget",
        tokens,
      });
    }
    return yield* Effect.tryPromise({
      try: () =>
        budgetProvider(sqlProvider, input.block)
          .set(String(input.maxTokens))
          .then(
            () =>
              ({
                _tag: "CoreMemoryBound",
                block: input.block,
                maxTokens: input.maxTokens,
              }) as const,
          ),
      catch: (cause) =>
        new CoreMemoryUnavailable({
          cause,
          message: "The Core Memory budget could not be changed",
          operation: "bound",
        }),
    });
  });

/** Clear one exact-approved Core Memory block without changing the other block. */
export const clearCoreMemory = (
  session: Session,
  input: ClearCoreMemoryInput,
): Effect.Effect<CoreMemoryCleared, CoreMemoryUnavailable> =>
  Effect.tryPromise({
    try: () =>
      session
        .replaceContextBlock(labelFor(input.block), "")
        .then(() => session.refreshSystemPrompt())
        .then(() => ({ _tag: "CoreMemoryCleared", block: input.block }) as const),
    catch: (cause) =>
      new CoreMemoryUnavailable({
        cause,
        message: "Core Memory could not be cleared",
        operation: "clear",
      }),
  });

/** Build the destructive Core Memory Action that Think releases only after exact Approval. */
export const makeCoreMemoryClearAction = (options: {
  readonly clear: (
    input: ClearCoreMemoryInput,
  ) => Promise<CoreMemoryCleared | CoreMemoryUnavailable>;
}) =>
  action({
    approval: true,
    approvalRisk: "high",
    approvalSummary: "Clear the selected Core Memory block",
    description: "Clear one selected Core Memory block after exact human Approval.",
    // oxlint-disable-next-line effecttsgo/async-function -- Think Actions require a Promise-returning execute callback.
    execute: async (input) => await options.clear(input),
    idempotencyKey: ({ ctx }) => `core-memory-clear:${ctx.toolCallId}`,
    inputSchema: Schema.toStandardSchemaV1(ClearCoreMemoryInput),
    kind: "durable-pause",
    permissions: ["memory:clear"],
  });

/** Project the exact selected block into a client-safe Approval presentation. */
export const presentCoreMemoryClearAction = (
  pending: PendingThinkAction,
): Effect.Effect<ActionPresentation, ActionPresentationUnavailable> => {
  if (pending.descriptor.action !== coreMemoryClearAction) {
    return Effect.fail(
      new ActionPresentationUnavailable({
        action: pending.descriptor.action,
        message: "The Action definition has no client-safe presentation",
      }),
    );
  }
  return Schema.decodeUnknownEffect(ClearCoreMemoryInput)(pending.descriptor.input).pipe(
    Effect.mapError(
      () =>
        new ActionPresentationUnavailable({
          action: pending.descriptor.action,
          message: "The Core Memory clear input cannot be projected safely",
        }),
    ),
    Effect.map((input) =>
      ActionPresentation.make({
        actionDefinitionVersion: "osfo-core-memory-clear-v1",
        actionId: ActionId.make(pending.descriptor.toolCallId),
        consequences: [`Permanently clear the ${labelFor(input.block)} block.`],
        description: `Clear the ${labelFor(input.block)} block.`,
        fields: [{ label: "Block", name: "block", value: labelFor(input.block) }],
        operation: "memory.clear",
        presentationId: ActionPresentationId.make(pending.executionId),
        title: `Clear ${labelFor(input.block)}`,
      }),
    ),
  );
};

/** Remove fields not owned by the Core Memory clear Action input. */
/* oxlint-disable osfo/no-unknown-parameters -- This parses Think's untyped descriptor boundary. */
export const sanitizeCoreMemoryClearActionInput = (
  input: unknown,
): ClearCoreMemoryInput | Record<string, never> =>
  Schema.decodeUnknownOption(ClearCoreMemoryInput)(input).pipe(
    Option.match({ onNone: () => ({}), onSome: (safe) => safe }),
  );
/* oxlint-enable osfo/no-unknown-parameters */

/** Name registered with Think for the Core Memory clear Action. */
export const coreMemoryClearActionName = coreMemoryClearAction;

const requireBlock = (session: Session, label: string): ContextBlock => {
  const block = session.getContextBlock(label);
  if (block === null) throw new Error(`Required Core Memory block is missing: ${label}`);
  return block;
};

const inspectBlock = (block: ContextBlock): CoreMemoryBlockInspection => ({
  content: block.content,
  maxTokens: requireBudget(block),
  tokens: block.tokens,
});

const labelFor = (block: CoreMemoryBlockName) =>
  block === "userContext" ? userContextLabel : agentNotesLabel;

const maxTokensFor = (block: CoreMemoryBlockName) =>
  block === "userContext" ? userContextMaxTokens : agentNotesMaxTokens;

const contentProvider = (sqlProvider: SqlProvider, block: CoreMemoryBlockName) =>
  new AgentContextProvider(sqlProvider, `osfo_core_memory_${blockKey(block)}`);

const budgetProvider = (sqlProvider: SqlProvider, block: CoreMemoryBlockName) =>
  new AgentContextProvider(sqlProvider, `osfo_core_memory_${blockKey(block)}_max_tokens`);

const blockKey = (block: CoreMemoryBlockName) =>
  block === "userContext" ? "user_context" : "agent_notes";

const readBudget = (sqlProvider: SqlProvider, block: CoreMemoryBlockName) =>
  budgetProvider(sqlProvider, block)
    .get()
    .then((stored) => {
      if (stored === null) return maxTokensFor(block);
      return Schema.decodeSync(configurableTokenBudget)(Number(stored));
    });

const requireBudget = (block: ContextBlock): number => {
  if (block.maxTokens === undefined) {
    throw new Error(`Required Core Memory budget is missing: ${block.label}`);
  }
  return block.maxTokens;
};
