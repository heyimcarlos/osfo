import { Session, Think, type ChatResponseResult, type SessionMessage } from "@cloudflare/think";
import { Effect, Option, Schema } from "effect";

import type { SessionId } from "../../domain";
import {
  AgentId,
  ConversationRouteId as ConversationRouteIdSchema,
  SessionId as SessionIdSchema,
} from "../../domain";
import { decodeOsfoStage } from "../../env";
import {
  invalidOsfoEnvironment,
  makeOsfoAgentRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../../layers";
import { makeAgentDb } from "./db/client";
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

/** Canonical Think messages read for one Agent-owned Session. */
export interface CanonicalSessionFound {
  readonly _tag: "CanonicalSessionFound";
  readonly messages: ReadonlyArray<SessionMessage>;
  readonly sessionId: SessionId;
}

/** Expected read result when a Session does not belong to the Agent. */
export interface CanonicalSessionNotFound {
  readonly _tag: "CanonicalSessionNotFound";
  readonly message: string;
}

/** Observable result of reading canonical Think Session history. */
export type CanonicalSessionRead = CanonicalSessionFound | CanonicalSessionNotFound;

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
    const current = await Effect.runPromise(Effect.option(this.#store.readPrimarySessionId()));
    return session.forSession(Option.getOrElse(current, () => pendingSessionId));
  }

  /** Reconcile committed Think messages when a new Agent activation starts. */
  override async onStart(): Promise<void> {
    await this.#reconcileCommittedTurns();
  }

  /** Idempotently establish the initialization fact, primary route, and current Session. */
  async initialize(input: AgentInitializationEncoded): Promise<AgentInitialized> {
    await this.#migrationsReady;
    const namedAgentId = await Effect.runPromise(Schema.decodeEffect(AgentId)(this.name));
    const parsed = await Effect.runPromise(Schema.decodeEffect(AgentInitializationInput)(input));
    const initialized = await Effect.runPromise(this.#store.initialize(namedAgentId, parsed));
    await this.#activateCurrentSession();
    return initialized;
  }

  /** Look up the stable initialization fact and current primary Session. */
  async inspect(): Promise<AgentFound> {
    await this.#migrationsReady;
    return Effect.runPromise(this.#store.inspect());
  }

  /** Replace one route's current Session while retaining canonical history. */
  async replaceCurrentSession(
    input: ReplaceCurrentSessionEncoded,
  ): Promise<CurrentSessionReplaced> {
    await this.#migrationsReady;
    const parsed = await Effect.runPromise(Schema.decodeEffect(ReplaceCurrentSessionInput)(input));
    const replaced = await Effect.runPromise(this.#store.replaceCurrentSession(parsed));
    await this.#activateCurrentSession();
    return replaced;
  }

  /** Read the current and historical Session identities for one route. */
  async readRoute(routeId: string): Promise<ConversationRouteFound> {
    await this.#migrationsReady;
    const parsed = await Effect.runPromise(Schema.decodeEffect(ConversationRouteIdSchema)(routeId));
    return Effect.runPromise(this.#store.readRoute(parsed));
  }

  /** Read canonical message history through Think for one Agent-owned Session. */
  async readSession(sessionId: string): Promise<CanonicalSessionRead> {
    await this.#migrationsReady;
    const parsed = await Effect.runPromise(Schema.decodeEffect(SessionIdSchema)(sessionId));
    const owned = await Effect.runPromise(this.#store.ownsSession(parsed));
    if (!owned) {
      return {
        _tag: "CanonicalSessionNotFound",
        message: "The Think Session does not belong to this Agent",
      };
    }
    const messages = await Session.create(this).forSession(parsed).getHistory();
    return { _tag: "CanonicalSessionFound", messages, sessionId: parsed };
  }

  /** Record one correlation reference after Think commits a completed response. */
  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    if (result.status !== "completed") return;
    await this.#migrationsReady;
    const current = await Effect.runPromise(Effect.option(this.#store.readPrimarySessionId()));
    if (Option.isNone(current)) return;
    await Effect.runPromise(
      this.#store.recordCommittedTurn({
        assistantMessageId: result.message.id,
        sessionId: current.value,
        source: "hook",
        thinkRequestId: result.requestId,
      }),
    );
  }

  /** Read idempotent committed-turn references owned by this Agent. */
  async readCommittedTurns(): Promise<ReadonlyArray<CommittedTurnReceipt>> {
    await this.#migrationsReady;
    await this.#reconcileCommittedTurns();
    return Effect.runPromise(this.#store.readCommittedTurns);
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

  async #reconcileCommittedTurns(): Promise<void> {
    await this.#migrationsReady;
    const sessionIds = await Effect.runPromise(this.#store.readSessionIds);
    await Effect.runPromise(
      Effect.forEach(
        sessionIds,
        (sessionId) =>
          Effect.promise(() => Session.create(this).forSession(sessionId).getHistory()).pipe(
            Effect.flatMap((messages) =>
              Effect.forEach(
                messages.filter(({ role }) => role === "assistant"),
                (message) =>
                  this.#store.recordCommittedTurn({
                    assistantMessageId: message.id,
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
    );
  }
}
