import { tool, type ToolSet } from "ai";
import { DateTime, Effect, Exit, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { ToolCallId, type AgentId } from "../../domain";
import type { OriginatingAuthority } from "../../domain/authority";
import type { ManagedTurnMetadata } from "../../domain/managed-conversation";
import {
  GmailDraftInput,
  GmailMessageId,
  GmailReadInput,
  GmailSearchInput,
  type GmailSendInput,
} from "../../domain/gmail";
import { retainedCatalog } from "../../domain/plan-policy";
import { database as workerDatabase } from "../../db";
import * as Billing from "../../db/billing";
import * as CurrentGmailAuthorization from "../../db/gmail/authorization";
import * as ProductionGmail from "../../integrations/gmail/production";
import type { makeOsfoAgentRuntime } from "../../layers";
import type { AuthRouteConfig } from "../../auth";
import * as AgentDirectory from "../../services/agent-directory";
import * as Allowances from "../../services/allowances";
import {
  type AuthorizationContext,
  type Denied,
  make as makeAuthorization,
} from "../../services/authorization";
import * as AuthorizationContextProjection from "../../services/authorization-context";
import { make as makeGmail, type Interface as Gmail } from "../../services/gmail";
import { makeGmailSendAction } from "./gmail-send-think-action";

const GmailSearchToolInput = Schema.Struct({
  maximumMessages: GmailSearchInput.fields.maximumMessages,
  query: GmailSearchInput.fields.query,
});
const GmailReadToolInput = Schema.Struct({ messageId: GmailMessageId });
const GmailDraftToolInput = Schema.Struct({
  body: GmailDraftInput.fields.body,
  recipient: GmailDraftInput.fields.recipient,
  selectedResourceId: GmailDraftInput.fields.selectedResourceId,
  subject: GmailDraftInput.fields.subject,
});

/** Production Gmail composition owned by one Osfo Agent activation. */
export interface Options {
  readonly activeTurnMetadata: () => Option.Option<ManagedTurnMetadata>;
  readonly agentId: AgentId;
  readonly auth: AuthRouteConfig;
  readonly runtime: ReturnType<typeof makeOsfoAgentRuntime>;
}

/** Build the Gmail tools and exact send Action over current production authority. */
export const make = (options: Options) => ({
  action: makeGmailSendAction({
    execute: (input) => executeApprovedSend(options, input),
  }),
  tools: makeTools(options),
});

const makeTools = (options: Options): ToolSet => ({
  gmailDraft: tool({
    description: "Create an email draft locally without writing it to Gmail.",
    inputSchema: Schema.toStandardSchemaV1(GmailDraftToolInput),
    // oxlint-disable-next-line effecttsgo/async-function -- AI SDK tools require a Promise-returning execute callback.
    execute: async (input, context) =>
      Effect.runPromise(
        runGmail(options, activeOrigin(options), "new", (gmail, authorization) =>
          gmail.draft(
            authorization,
            GmailDraftInput.make({ ...input, toolCallId: ToolCallId.make(context.toolCallId) }),
          ),
        ),
      ),
  }),
  gmailRead: tool({
    description: "Read one selected Gmail message for local summary or drafting.",
    inputSchema: Schema.toStandardSchemaV1(GmailReadToolInput),
    // oxlint-disable-next-line effecttsgo/async-function -- AI SDK tools require a Promise-returning execute callback.
    execute: async (input, context) =>
      Effect.runPromise(
        runGmail(options, activeOrigin(options), "new", (gmail, authorization) =>
          gmail.read(
            authorization,
            GmailReadInput.make({ ...input, toolCallId: ToolCallId.make(context.toolCallId) }),
          ),
        ),
      ),
  }),
  gmailSearch: tool({
    description: "Search Gmail on demand and return at most 25 message summaries.",
    inputSchema: Schema.toStandardSchemaV1(GmailSearchToolInput),
    // oxlint-disable-next-line effecttsgo/async-function -- AI SDK tools require a Promise-returning execute callback.
    execute: async (input, context) =>
      Effect.runPromise(
        runGmail(options, activeOrigin(options), "new", (gmail, authorization) =>
          gmail.search(
            authorization,
            GmailSearchInput.make({ ...input, toolCallId: ToolCallId.make(context.toolCallId) }),
          ),
        ),
      ),
  }),
});

const executeApprovedSend = (options: Options, input: GmailSendInput) =>
  Option.match(options.activeTurnMetadata(), {
    onNone: () =>
      Effect.succeed({
        _tag: "Denied",
        reason: "authorityMismatch",
        resetAt: null,
      } satisfies Denied),
    onSome: (metadata) =>
      runGmail(
        options,
        Option.some(metadata.originatingAuthority),
        "resumed",
        (gmail, authorization) =>
          gmail.sendApproved(authorization, input, metadata.allowancePeriodId),
      ),
  });

const runGmail = <A, E>(
  options: Options,
  originatingAuthority: Option.Option<OriginatingAuthority>,
  work: "new" | "resumed",
  execute: (gmail: Gmail, authorization: AuthorizationContext) => Effect.Effect<A, E>,
) => {
  if (Option.isNone(originatingAuthority)) {
    return Effect.succeed({
      _tag: "Denied",
      reason: "authorityMismatch",
      resetAt: null,
    } satisfies Denied);
  }
  const inner = Effect.scoped(
    Effect.gen(function* () {
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const database = yield* workerDatabase;
      const owner = yield* AgentDirectory.make.pipe(
        Effect.flatMap((directory) => directory.resolveAgent(options.agentId)),
      );
      const facts = yield* work === "new"
        ? CurrentGmailAuthorization.loadInitial(
            database,
            owner.userId,
            originatingAuthority.value,
            now,
          )
        : CurrentGmailAuthorization.loadResumed(
            database,
            owner.userId,
            originatingAuthority.value,
            now,
          );
      const billing = Billing.make(database);
      const production = yield* ProductionGmail.make(database, options.auth);
      const gmail = makeGmail({
        allowances: Allowances.make({
          billing,
          catalog: retainedCatalog,
          now: Effect.succeed(now),
        }),
        attempts: production.database.attempts,
        authorization: makeAuthorization(retainedCatalog),
        connections: production.database.connections,
        provider: production.provider,
        reloadAuthorization: (previous) =>
          DateTime.now.pipe(
            Effect.map(DateTime.toDateUtc),
            Effect.flatMap((recheckedAt) =>
              CurrentGmailAuthorization.reload(
                database,
                {
                  allowance: previous.allowance,
                  originatingAuthority: previous.originatingAuthority,
                  userId: previous.user.userId,
                },
                recheckedAt,
              ),
            ),
            Effect.map(AuthorizationContextProjection.project),
          ),
      });
      return yield* execute(gmail, AuthorizationContextProjection.project(facts));
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The Durable Object tool or Action is this external HTTP entry point.
      Effect.provide(FetchHttpClient.layer),
    ),
  );
  return Effect.promise(() => options.runtime.runPromiseExit(inner)).pipe(
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
    ),
  );
};

const activeOrigin = (options: Options) =>
  Option.map(options.activeTurnMetadata(), ({ originatingAuthority }) => originatingAuthority);
