import { Session, Think, type ChatResponseResult } from "@cloudflare/think";
import { Effect, Option, Schema } from "effect";

import type { AssistantMessageId as AssistantMessageIdType, SessionId } from "../../domain";
import {
  AgentId,
  AssistantMessageId,
  ChannelBindingId,
  ConversationRouteId as ConversationRouteIdSchema,
  SessionId as SessionIdSchema,
  ThinkRequestId,
} from "../../domain";
import { decodeOsfoStage } from "../../env";
import {
  invalidOsfoEnvironment,
  makeOsfoAgentRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../../layers";
import { makeAgentDb } from "./db/client";
import {
  type AgentInitializationConflict,
  AgentRequestInvalid,
  type AgentRequestOperation,
  AgentStateNotFound,
  type AgentStoreRecordInvalid,
  type AgentStoreUnavailable,
  CommittedTurnConflict,
  type CurrentSessionReplacementConflict,
  ThinkSessionReadUnavailable,
  ThinkSessionRecordInvalid,
  ThinkSessionWriteUnavailable,
} from "./db/errors";
import { applyAgentMigrations } from "./db/migrate";
import {
  AgentInitializationInput,
  type AgentInitializationEncoded,
  type AgentInitialized,
  type AgentFound,
  type CommittedTurnReceipt,
  type ConversationRouteFound,
  type CurrentSessionReplaced,
  makeAgentStore,
  ReplaceCurrentSessionInput,
  type ReplaceCurrentSessionEncoded,
} from "./db/store";

/* oxlint-disable effecttsgo/async-function -- Cloudflare Agent RPC and lifecycle hooks require Promise boundaries. */

const pendingSessionId = "__osfo_uninitialized__";

const SessionHistoryMessagePart = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);

/** Osfo-owned boundary shape for one message returned from Think Session history. */
export const SessionHistoryMessage = Schema.StructWithRest(
  Schema.Struct({
    createdAt: Schema.optional(Schema.Union([Schema.Date, Schema.String])),
    id: Schema.String,
    parts: Schema.Array(SessionHistoryMessagePart),
    role: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** Osfo-owned boundary shape for one message returned from Think Session history. */
export type SessionHistoryMessage = typeof SessionHistoryMessage.Type;

/** Think Session history read for one Agent-owned Session. */
export interface SessionHistoryFound {
  readonly _tag: "SessionHistoryFound";
  readonly messages: ReadonlyArray<SessionHistoryMessage>;
  readonly sessionId: SessionId;
}

/** Expected read result when a Session does not belong to the Agent. */
export interface SessionHistoryNotFound {
  readonly _tag: "SessionHistoryNotFound";
  readonly message: string;
}

/** Observable result of reading Think Session history. */
export type SessionHistoryRead = SessionHistoryFound | SessionHistoryNotFound;

const PersonalWelcomeInput = Schema.Struct({
  channelBindingId: ChannelBindingId,
  helpAreas: Schema.Array(
    Schema.Literals([
      "writing-email",
      "scheduling-reminders",
      "research",
      "files-documents",
      "money-planning",
      "something-else",
    ]),
  ),
  locale: Schema.Literals(["en", "es"]),
  preferredName: Schema.NullOr(Schema.String),
});
type PersonalWelcomeEncoded = typeof PersonalWelcomeInput.Encoded;

/** Durable result for the deterministic first personal response. */
export interface PersonalWelcomeCommitted {
  readonly _tag: "PersonalWelcomeCommitted";
  readonly messageId: AssistantMessageIdType;
  readonly sessionId: SessionId;
  readonly text: string;
}

/** User-scoped Think Durable Object with stable Osfo Agent and Session identity. */
export class OsfoAgent extends Think<Env> {
  /** Keep shell execution unavailable until a concrete Osfo tool contract enables it. */
  override workspaceBash = false;

  readonly #db = makeAgentDb(this.ctx.storage);
  readonly #store = makeAgentStore(this.#db);
  readonly #migrationsReady = this.ctx.blockConcurrencyWhile(() =>
    Effect.runPromise(applyAgentMigrations(this.ctx.storage)),
  );
  readonly #runtime = Option.map(decodeOsfoStage(this.env.OSFO_STAGE), (stage) =>
    makeOsfoAgentRuntime(this.ctx.id.name ?? this.ctx.id.toString(), stage),
  );

  /** Select the current primary Think Session after migration exclusion completes. */
  override async configureSession(session: Session): Promise<Session> {
    await this.#migrationsReady;
    const current = await Effect.runPromise(this.#readOptionalPrimarySessionId());
    return session.forSession(Option.getOrElse(current, () => pendingSessionId));
  }

  /** Reconcile committed Think messages when a new Agent activation starts. */
  override async onStart(): Promise<void> {
    await this.#migrationsReady;
    await Effect.runPromise(this.#reconcileCommittedTurns());
  }

  /** Idempotently establish the initialization fact, primary route, and current Session. */
  async initialize(
    input: AgentInitializationEncoded,
  ): Promise<
    | AgentInitializationConflict
    | AgentInitialized
    | AgentRequestInvalid
    | AgentStateNotFound
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
  > {
    await this.#migrationsReady;
    const agentName = this.name;
    const store = this.#store;
    const outcome = await runRpc(
      Effect.gen(function* () {
        const namedAgentId = yield* Schema.decodeEffect(AgentId)(agentName).pipe(
          Effect.mapError(() => invalidRequest("initialize")),
        );
        const parsed = yield* Schema.decodeEffect(AgentInitializationInput)(input).pipe(
          Effect.mapError(() => invalidRequest("initialize")),
        );
        return yield* store.initialize(namedAgentId, parsed);
      }),
    );
    if ("currentSessionId" in outcome) await this.#activateCurrentSession();
    return outcome;
  }

  /** Look up the stable initialization fact and current primary Session. */
  async inspect(): Promise<
    AgentFound | AgentStateNotFound | AgentStoreRecordInvalid | AgentStoreUnavailable
  > {
    await this.#migrationsReady;
    return runRpc(this.#store.inspect());
  }

  /** Commit the first localized personal response without running a model turn. */
  async commitWelcome(
    input: PersonalWelcomeEncoded,
  ): Promise<
    | AgentRequestInvalid
    | AgentStateNotFound
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
    | CommittedTurnConflict
    | PersonalWelcomeCommitted
    | ThinkSessionWriteUnavailable
  > {
    await this.#migrationsReady;
    const activateCurrentSession = () => this.#activateCurrentSession();
    const addWelcome = (message: {
      readonly id: string;
      readonly parts: Array<{ readonly text: string; readonly type: "text" }>;
      readonly role: "assistant";
    }) => this.addMessages([message]);
    const store = this.#store;
    return runRpc(
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeEffect(PersonalWelcomeInput)(input).pipe(
          Effect.mapError(() => invalidRequest("commitWelcome")),
        );
        const agent = yield* store.inspect();
        const messageId = AssistantMessageId.make(`welcome-${parsed.channelBindingId}`);
        const text = personalWelcome(parsed);
        yield* Effect.tryPromise({
          try: async () => {
            await activateCurrentSession();
            await addWelcome({
              id: messageId,
              parts: [{ text, type: "text" }],
              role: "assistant",
            });
          },
          catch: (cause) =>
            new ThinkSessionWriteUnavailable({
              cause,
              message: "The personal welcome could not be persisted",
              sessionId: agent.currentSessionId,
            }),
        });
        yield* store.recordCommittedTurn({
          assistantMessageId: messageId,
          sessionId: agent.currentSessionId,
          source: "reconciliation",
          thinkRequestId: null,
        });
        return {
          _tag: "PersonalWelcomeCommitted",
          messageId,
          sessionId: agent.currentSessionId,
          text,
        } as const;
      }),
    );
  }

  /** Replace one route's current Session while retaining canonical history. */
  async replaceCurrentSession(
    input: ReplaceCurrentSessionEncoded,
  ): Promise<
    | AgentRequestInvalid
    | AgentStateNotFound
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
    | CurrentSessionReplaced
    | CurrentSessionReplacementConflict
  > {
    await this.#migrationsReady;
    const outcome = await runRpc(
      Schema.decodeEffect(ReplaceCurrentSessionInput)(input).pipe(
        Effect.mapError(() => invalidRequest("replaceCurrentSession")),
        Effect.flatMap((parsed) => this.#store.replaceCurrentSession(parsed)),
      ),
    );
    if ("currentSessionId" in outcome) await this.#activateCurrentSession();
    return outcome;
  }

  /** Read the current and historical Session identities for one route. */
  async readRoute(
    routeId: string,
  ): Promise<
    | AgentRequestInvalid
    | AgentStateNotFound
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
    | ConversationRouteFound
  > {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(ConversationRouteIdSchema)(routeId).pipe(
        Effect.mapError(() => invalidRequest("readRoute")),
        Effect.flatMap((parsed) => this.#store.readRoute(parsed)),
      ),
    );
  }

  /** Read Think Session history for one Agent-owned Session. */
  async readSession(
    sessionId: string,
  ): Promise<
    | AgentRequestInvalid
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
    | SessionHistoryRead
    | ThinkSessionReadUnavailable
    | ThinkSessionRecordInvalid
  > {
    await this.#migrationsReady;
    const session = Session.create(this);
    const store = this.#store;
    return runRpc(
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeEffect(SessionIdSchema)(sessionId).pipe(
          Effect.mapError(() => invalidRequest("readSession")),
        );
        const owned = yield* store.ownsSession(parsed);
        if (!owned) {
          return {
            _tag: "SessionHistoryNotFound",
            message: "The Think Session does not belong to this Agent",
          } as const;
        }
        const messages = yield* readThinkHistory(session, parsed);
        return { _tag: "SessionHistoryFound", messages, sessionId: parsed } as const;
      }),
    );
  }

  /** Record one correlation reference after Think commits a completed response. */
  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    if (result.status !== "completed") return;
    await this.#migrationsReady;
    const assistantMessageId = AssistantMessageId.make(result.message.id);
    const thinkRequestId = ThinkRequestId.make(result.requestId);
    await Effect.runPromise(
      this.#findThinkMessageOwner(assistantMessageId, thinkRequestId).pipe(
        Effect.flatMap((sessionId) =>
          this.#store.recordCommittedTurn({
            assistantMessageId,
            sessionId,
            source: "hook",
            thinkRequestId,
          }),
        ),
      ),
    );
  }

  /** Read idempotent committed-turn references owned by this Agent. */
  async readCommittedTurns(): Promise<
    | AgentStoreUnavailable
    | AgentStoreRecordInvalid
    | CommittedTurnConflict
    | ReadonlyArray<CommittedTurnReceipt>
    | ThinkSessionReadUnavailable
    | ThinkSessionRecordInvalid
  > {
    await this.#migrationsReady;
    return runRpc(
      this.#reconcileCommittedTurns().pipe(Effect.andThen(this.#store.readCommittedTurns)),
    );
  }

  /** Return the technical runtime identity for local smoke verification. */
  probeRuntime(): Promise<RuntimeProbeResult> {
    return Option.match(this.#runtime, {
      onNone: () => Promise.resolve(invalidOsfoEnvironment),
      onSome: (runtime) => runtime.runPromise(probeExecutionUnit),
    });
  }

  async #activateCurrentSession(): Promise<void> {
    this.session = await this.configureSession(Session.create(this));
    this.session.internal_onMessagesChanged(async () => {
      await this.syncMessagesFromStorage();
    });
    await this.syncMessagesFromStorage();
  }

  #readOptionalPrimarySessionId() {
    return this.#store.readPrimarySessionId().pipe(
      Effect.map(Option.some),
      Effect.catchTag("AgentStateNotFound", () => Effect.succeed(Option.none<SessionId>())),
    );
  }

  #findThinkMessageOwner(
    assistantMessageId: AssistantMessageIdType,
    thinkRequestId: ThinkRequestId,
  ) {
    const makeSession = () => Session.create(this);
    const store = this.#store;
    return Effect.gen(function* () {
      const sessionIds = yield* store.readSessionIds;
      const matches = yield* Effect.forEach(
        sessionIds,
        (sessionId) =>
          readThinkMessage(makeSession(), sessionId, assistantMessageId).pipe(
            Effect.map((message) => (message === null ? null : sessionId)),
          ),
        { concurrency: 1 },
      );
      const owners = matches.filter((sessionId): sessionId is SessionId => sessionId !== null);
      const owner = owners[0];
      if (owner === undefined) {
        return yield* new AgentStateNotFound({
          message: "The committed assistant message does not belong to an Agent Session",
          subject: "session",
        });
      }
      if (owners.length > 1) {
        const conflictingOwner = owners.at(1) ?? owner;
        return yield* new CommittedTurnConflict({
          assistantMessageId,
          existingAssistantMessageId: assistantMessageId,
          existingSessionId: owner,
          existingThinkRequestId: thinkRequestId,
          message: "The assistant message appears in more than one Think Session",
          sessionId: conflictingOwner,
          thinkRequestId,
        });
      }
      return owner;
    });
  }

  #reconcileCommittedTurns(): Effect.Effect<
    void,
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
    | CommittedTurnConflict
    | ThinkSessionReadUnavailable
    | ThinkSessionRecordInvalid
  > {
    return this.#store.readSessionIds.pipe(
      Effect.flatMap((sessionIds) =>
        Effect.forEach(
          sessionIds,
          (sessionId) =>
            readThinkHistory(Session.create(this), sessionId).pipe(
              Effect.flatMap((messages) =>
                Effect.forEach(
                  messages.filter(({ role }) => role === "assistant"),
                  (message) =>
                    this.#store.recordCommittedTurn({
                      assistantMessageId: AssistantMessageId.make(message.id),
                      sessionId,
                      source: "reconciliation",
                      thinkRequestId: null,
                    }),
                  { concurrency: 1, discard: true },
                ),
              ),
            ),
          { concurrency: 1, discard: true },
        ),
      ),
    );
  }
}

const invalidRequest = (operation: AgentRequestOperation): AgentRequestInvalid =>
  new AgentRequestInvalid({ message: "The Agent RPC input is invalid", operation });

const personalWelcome = (profile: typeof PersonalWelcomeInput.Type): string => {
  const preferredName = profile.preferredName?.trim();
  const name = preferredName === undefined || preferredName.length === 0 ? "" : ` ${preferredName}`;
  const areas = profile.helpAreas.map((area) => helpAreaLabels[profile.locale][area]);
  if (profile.locale === "es") {
    const selected = areas.length === 0 ? "" : ` Elegiste ${formatList(areas, "y")}.`;
    return `Hola${name}, estoy listo.${selected} ¿En qué trabajamos primero?`;
  }
  const selected = areas.length === 0 ? "" : ` You selected ${formatList(areas, "and")}.`;
  return `Hi${name}, I'm ready.${selected} What should we work on first?`;
};

const helpAreaLabels = {
  en: {
    "files-documents": "files and documents",
    "money-planning": "money and planning",
    research: "research",
    "scheduling-reminders": "scheduling and reminders",
    "something-else": "something else",
    "writing-email": "writing and email",
  },
  es: {
    "files-documents": "archivos y documentos",
    "money-planning": "dinero y planificación",
    research: "investigación",
    "scheduling-reminders": "agenda y recordatorios",
    "something-else": "algo más",
    "writing-email": "redacción y correo",
  },
} as const;

const formatList = (values: ReadonlyArray<string>, conjunction: string): string => {
  if (values.length < 2) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} ${conjunction} ${values.at(-1)}`;
};

const readThinkHistory = (session: Session, sessionId: SessionId) =>
  Effect.tryPromise({
    catch: (cause) =>
      new ThinkSessionReadUnavailable({
        cause,
        message: "Think Session history is unavailable",
        sessionId,
      }),
    try: () => session.forSession(sessionId).getHistory(),
  }).pipe(
    Effect.flatMap((messages) =>
      Schema.decodeUnknownEffect(Schema.Array(SessionHistoryMessage))(messages).pipe(
        Effect.mapError(
          () =>
            new ThinkSessionRecordInvalid({
              message: "Think Session history contains an invalid message",
              sessionId,
            }),
        ),
      ),
    ),
  );

const readThinkMessage = (
  session: Session,
  sessionId: SessionId,
  assistantMessageId: AssistantMessageIdType,
) =>
  Effect.tryPromise({
    catch: (cause) =>
      new ThinkSessionReadUnavailable({
        cause,
        message: "Think Session message lookup is unavailable",
        sessionId,
      }),
    try: () => session.forSession(sessionId).getMessage(assistantMessageId),
  }).pipe(
    Effect.flatMap((message) =>
      Schema.decodeUnknownEffect(Schema.NullOr(SessionHistoryMessage))(message).pipe(
        Effect.mapError(
          () =>
            new ThinkSessionRecordInvalid({
              message: "Think Session message lookup returned an invalid message",
              sessionId,
            }),
        ),
      ),
    ),
  );

const runRpc = <A, E>(effect: Effect.Effect<A, E>): Promise<A | E> =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (failure) => failure,
        onSuccess: (value) => value,
      }),
    ),
  );
