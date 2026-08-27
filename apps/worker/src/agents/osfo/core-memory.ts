import type { Session } from "@cloudflare/think";
import { tool, type ToolSet } from "ai";
import {
  AgentContextProvider,
  type ContextBlock,
  type SqlProvider,
} from "agents/experimental/memory/session";
import { estimateStringTokens } from "agents/experimental/memory/utils";
import { Context, Data, Effect, Result, Schema } from "effect";

import { AuthorizationContext } from "../../services/authorization";
import { effectToolSchema } from "./effect-tool-schema";

interface CoreMemoryBatchSession {
  readonly getContextBlock: (label: string) => ContextBlock | null;
  readonly refreshSystemPrompt: () => Promise<string>;
}

interface CoreMemoryBatchStorage {
  readonly sql: {
    readonly exec: (
      query: string,
      ...bindings: ReadonlyArray<string>
    ) => { readonly toArray: () => ReadonlyArray<{ readonly content?: string | null }> };
  };
  readonly transactionSync: <A>(transaction: () => A) => A;
}

class CoreMemoryTransactionFailed extends Data.TaggedError("CoreMemoryTransactionFailed")<{
  readonly cause: unknown;
}> {}

const positiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));
const configurableTokenBudget = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(8_000),
);

/** The two independently managed Core Memory blocks. */
export const CoreMemoryBlockName = Schema.Literals(["userContext", "agentNotes"]);

/** The two independently managed Core Memory blocks. */
export type CoreMemoryBlockName = typeof CoreMemoryBlockName.Type;

const coreMemoryBlocks = {
  agentNotes: {
    defaultMaxTokens: 800,
    description:
      "Proactively keep current goals, commitments, environment facts, workflow facts, and continuity useful across Sessions. Store the narrowest durable conclusion. Never store hidden reasoning, chain-of-thought, a task log, or a Session transcript.",
    label: "Agent Notes",
    storageKey: "agent_notes",
  },
  userContext: {
    defaultMaxTokens: 1_200,
    description:
      "Proactively keep only narrow durable User facts and useful inferences. Sensitive or high-impact health, religion, politics, sexuality, legal-status, or financial-condition inferences require strong direct evidence or User confirmation. Apply a current User correction immediately. Never store hidden reasoning, chain-of-thought, a transcript, or situational explanatory baggage.",
    label: "User Context",
    storageKey: "user_context",
  },
} as const satisfies Record<
  CoreMemoryBlockName,
  {
    readonly defaultMaxTokens: number;
    readonly description: string;
    readonly label: string;
    readonly storageKey: string;
  }
>;
const coreMemoryBlockNames = ["userContext", "agentNotes"] as const;

const SetCoreMemoryInput = Schema.Struct({
  action: Schema.Literals(["append", "replace"]),
  block: CoreMemoryBlockName,
  content: Schema.String.check(Schema.isMaxLength(10_000)),
});

/** Direct User correction that replaces the complete selected block. */
export const CorrectCoreMemoryInput = Schema.Struct({
  actionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  authorization: AuthorizationContext,
  block: CoreMemoryBlockName,
  content: Schema.String.check(Schema.isMaxLength(10_000)),
});

/** Parsed direct User correction for one Core Memory block. */
export type CorrectCoreMemoryInput = typeof CorrectCoreMemoryInput.Type;

/** RPC representation of a direct User correction. */
export type CorrectCoreMemoryEncoded = typeof CorrectCoreMemoryInput.Encoded;

/** Authorized inspection request for both Core Memory blocks. */
export const InspectCoreMemoryInput = Schema.Struct({
  actionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  authorization: AuthorizationContext,
});

/** Parsed authorized Core Memory inspection request. */
export type InspectCoreMemoryInput = typeof InspectCoreMemoryInput.Type;

/** RPC representation of one Core Memory inspection request. */
export type InspectCoreMemoryEncoded = typeof InspectCoreMemoryInput.Encoded;

/** User-selected finite budget for one Core Memory block. */
export const BoundCoreMemoryInput = Schema.Struct({
  actionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  authorization: AuthorizationContext,
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
    ([userContextBudget, agentNotesBudget]) => {
      const budgets = {
        agentNotes: agentNotesBudget,
        userContext: userContextBudget,
      };
      return coreMemoryBlockNames.reduce((configured, block) => {
        const definition = coreMemoryBlocks[block];
        return configured.withContext(definition.label, {
          description: definition.description,
          maxTokens: budgets[block],
          provider: contentProvider(sqlProvider, block),
        });
      }, session);
    },
  );

/** Build the validated model-write tool that overrides Think's generic context writer. */
export const coreMemoryTools = (session: Session): ToolSet => ({
  set_context: tool({
    description:
      "Write narrow durable non-sensitive Core Memory. Hidden reasoning and sensitive or high-impact content are prohibited. A User must add confirmed sensitive facts through direct correction.",
    execute: (input) => {
      if (hiddenReasoning.test(input.content)) {
        return Promise.resolve("Rejected: hidden reasoning cannot be stored in Core Memory.");
      }
      if (containsSensitiveUserAssertion(input.content, input.block)) {
        return Promise.resolve(
          "Rejected: model-authored sensitive content cannot be stored in Core Memory.",
        );
      }
      const update =
        input.action === "append"
          ? session.appendContextBlock(coreMemoryLabelFor(input.block), input.content)
          : session.replaceContextBlock(coreMemoryLabelFor(input.block), input.content);
      return Effect.runPromise(
        Effect.tryPromise({
          catch: (cause) =>
            new CoreMemoryUnavailable({
              cause,
              message: "Core Memory could not be updated",
              operation: "correct",
            }),
          try: () => update,
        }).pipe(
          Effect.match({
            onFailure: (failure) => `Error: ${failure.message}`,
            onSuccess: (block) =>
              `Written to ${block.label}. Usage: ${block.tokens}/${block.maxTokens ?? "unbounded"} tokens.`,
          }),
        ),
      );
    },
    inputSchema: effectToolSchema(SetCoreMemoryInput),
  }),
});

/** Inspect both user-readable Core Memory blocks through Think's public Session interface. */
export const inspectCoreMemory = (
  session: CoreMemoryBatchSession,
): Effect.Effect<CoreMemoryInspected, CoreMemoryUnavailable> =>
  Effect.tryPromise({
    try: () =>
      session.refreshSystemPrompt().then(() => {
        const userContext = requireBlock(session, labelFor("userContext"));
        const agentNotes = requireBlock(session, labelFor("agentNotes"));
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
  replaceCoreMemoryBlock(session, input);

/** Replace one Core Memory block after the caller establishes current authority. */
export const replaceCoreMemoryBlock = (
  session: Session,
  input: { readonly block: CoreMemoryBlockName; readonly content: string },
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

/** Replace an exact-approved Core Memory set as one Agent SQLite mutation. */
export const replaceCoreMemoryBlocks = <E, R, E2>(
  session: CoreMemoryBatchSession,
  storage: CoreMemoryBatchStorage,
  replacements: ReadonlyArray<{
    readonly block: CoreMemoryBlockName;
    readonly content: string;
    readonly expectedContent: string;
  }>,
  authorizeReplacement: Effect.Effect<void, E, R>,
  markCorrectionCommitted: Effect.Effect<void, E2>,
): Effect.Effect<
  ReadonlyArray<CoreMemoryCorrected>,
  CoreMemoryBudgetExceeded | CoreMemoryUnavailable | E | E2,
  R
> =>
  Effect.gen(function* () {
    const memory = yield* inspectCoreMemory(session);
    const corrected = yield* Effect.forEach(replacements, (replacement) => {
      const maxTokens = memory[replacement.block].maxTokens;
      const tokens = estimateStringTokens(replacement.content);
      return tokens > maxTokens
        ? Effect.fail(
            new CoreMemoryBudgetExceeded({
              block: replacement.block,
              maxTokens,
              message: "The Core Memory correction exceeds the selected block budget",
              tokens,
            }),
          )
        : Effect.succeed({
            _tag: "CoreMemoryCorrected" as const,
            block: replacement.block,
            content: replacement.content,
            maxTokens,
            tokens,
          });
    });
    yield* authorizeReplacement;
    let markerResult: Result.Result<void, E2> = Result.succeed(undefined);
    const markerRollback = new Error("Core Memory correction marker rejected");
    const transactionResult = yield* Effect.try({
      try: () =>
        storage.transactionSync(() => {
          // The installed AgentContextProvider owns these exact rows but exposes only one-block
          // writes. Use its version-matched schema here so one approved correction is atomic.
          const current = replacements.map((replacement) => {
            const [row] = storage.sql
              .exec(
                "SELECT content FROM cf_agents_context_blocks WHERE label = ? LIMIT 1",
                coreMemoryStorageKeyFor(replacement.block),
              )
              .toArray();
            return { replacement, content: row?.content ?? "" };
          });
          if (current.some(({ content, replacement }) => content !== replacement.expectedContent)) {
            throw new Error("Core Memory changed after the deletion Action was presented");
          }
          for (const { replacement } of current) {
            storage.sql.exec(
              `INSERT INTO cf_agents_context_blocks (label, content)
               VALUES (?, ?)
               ON CONFLICT(label) DO UPDATE
               SET content = excluded.content, updated_at = CURRENT_TIMESTAMP`,
              coreMemoryStorageKeyFor(replacement.block),
              replacement.content,
            );
          }
          markerResult = Effect.runSyncWith(Context.empty())(
            Effect.result(markCorrectionCommitted),
          );
          // SQLite rolls back transactionSync only when its callback throws. Keep this sentinel
          // private, then restore the marker's expected failure to the Effect channel below.
          if (Result.isFailure(markerResult)) throw markerRollback;
        }),
      catch: (cause) => new CoreMemoryTransactionFailed({ cause }),
    }).pipe(Effect.result);
    if (Result.isFailure(transactionResult)) {
      if (transactionResult.failure.cause === markerRollback && Result.isFailure(markerResult)) {
        // oxlint-disable-next-line effecttsgo/unnecessary-fail-yieldable-error -- E2 is generic and is not guaranteed to implement Effect's yieldable-error protocol.
        return yield* Effect.fail(markerResult.failure);
      }
      return yield* new CoreMemoryUnavailable({
        cause: transactionResult.failure.cause,
        message: "Core Memory could not be corrected atomically",
        operation: "correct",
      });
    }
    yield* refreshCoreMemoryPrompt(session);
    return corrected;
  });

/** Refresh the active prompt after an atomic Core Memory correction already committed. */
export const refreshCoreMemoryPrompt = (session: CoreMemoryBatchSession) =>
  Effect.tryPromise({
    try: () => session.refreshSystemPrompt(),
    catch: (cause) =>
      new CoreMemoryUnavailable({
        cause,
        message: "Corrected Core Memory could not be refreshed",
        operation: "correct",
      }),
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

const requireBlock = (session: CoreMemoryBatchSession, label: string): ContextBlock => {
  const block = session.getContextBlock(label);
  if (block === null) throw new Error(`Required Core Memory block is missing: ${label}`);
  return block;
};

const inspectBlock = (block: ContextBlock): CoreMemoryBlockInspection => ({
  content: block.content,
  maxTokens: requireBudget(block),
  tokens: block.tokens,
});

export const coreMemoryLabelFor = (block: CoreMemoryBlockName) => coreMemoryBlocks[block].label;

const labelFor = coreMemoryLabelFor;

const maxTokensFor = (block: CoreMemoryBlockName) => coreMemoryBlocks[block].defaultMaxTokens;

const coreMemoryStorageKeyFor = (block: CoreMemoryBlockName) =>
  `osfo_core_memory_${coreMemoryBlocks[block].storageKey}`;

const contentProvider = (sqlProvider: SqlProvider, block: CoreMemoryBlockName) =>
  new AgentContextProvider(sqlProvider, coreMemoryStorageKeyFor(block));

const budgetProvider = (sqlProvider: SqlProvider, block: CoreMemoryBlockName) =>
  new AgentContextProvider(
    sqlProvider,
    `osfo_core_memory_${coreMemoryBlocks[block].storageKey}_max_tokens`,
  );

const hiddenReasoning = /(?:chain[- ]of[- ]thought|hidden reasoning|<thinking>|reasoning:)/iu;
const unambiguousSensitiveInference =
  /\b(?:aids|anxiety|arrested?|atheist|autism|autistic|bankruptcy|bankrupt|bisexual|buddhist|cancer|christian|citizenship|convicted?|credit score|criminal|democrat|depression|diabetes|diagnosis|disabled|disability|gay|hindu|hiv|immigrant|immigration|insolvent|islam|jewish|lawsuit|legal status|lesbian|low[- ]income|medical|medication|mental illness|muslim|political|poverty|pregnant|queer|religion|religious|republican|sexual|therapy|transgender|undocumented)\b/iu;
const contextualSensitiveInference =
  /\b(?:conservative|debt|financial|health|income|liberal|poor|salary|voters?|voting|wealth|wealthy)\b/iu;
const safeOperationalContext =
  /\b(?:(?:quarterly )?financial (?:report|results)|(?:service|database) (?:has poor )?health|vote on (?:the )?(?:deployment|release) proposal|conservative (?:retry policy|backoff))\b/giu;

const containsSensitiveUserAssertion = (content: string, block: CoreMemoryBlockName): boolean =>
  content
    .split("\n")
    .some(
      (line) =>
        unambiguousSensitiveInference.test(line) ||
        (contextualSensitiveInference.test(line) &&
          (block === "userContext" ||
            contextualSensitiveInference.test(line.replace(safeOperationalContext, "")))),
    );
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
