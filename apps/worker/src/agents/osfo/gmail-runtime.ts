import { tool, type ToolSet } from "ai";
import { createAuth } from "@osfo/auth";
import type { Database } from "@osfo/db";
import { sessions } from "@osfo/db/schema/auth";
import { channelBindings } from "@osfo/db/schema/onboarding";
import { and, eq, gt, isNull } from "drizzle-orm";
import { DateTime, Effect, Exit, Option, Predicate, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import type { AgentId } from "../../domain";
import type { OriginatingAuthority } from "../../domain/authority";
import type { ManagedTurnMetadata } from "../../domain/managed-conversation";
import {
  GmailDraftInput,
  GmailMessageId,
  GmailPersistenceUnavailable,
  GmailProviderUnavailable,
  GmailReadInput,
  GmailSearchInput,
  type GmailSendInput,
} from "../../domain/gmail";
import { retainedCatalog } from "../../domain/plan-policy";
import { database as workerDatabase } from "../../db";
import * as Billing from "../../db/billing";
import * as GmailDb from "../../db/gmail";
import * as GmailApi from "../../integrations/gmail/api";
import type { makeOsfoAgentRuntime } from "../../layers";
import type { AuthRouteConfig } from "../../auth";
import * as AgentDirectory from "../../services/agent-directory";
import * as Allowances from "../../services/allowances";
import {
  AuthorizationContext,
  type Denied,
  make as makeAuthorization,
} from "../../services/authorization";
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

type GmailAllowanceAdmission = Effect.Success<ReturnType<Billing.Interface["admit"]>>;

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
        runGmail(options, activeOrigin(options), (gmail, authorization) =>
          gmail.draft(
            authorization,
            GmailDraftInput.make({ ...input, toolCallId: context.toolCallId }),
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
        runGmail(options, activeOrigin(options), (gmail, authorization) =>
          gmail.read(
            authorization,
            GmailReadInput.make({ ...input, toolCallId: context.toolCallId }),
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
        runGmail(options, activeOrigin(options), (gmail, authorization) =>
          gmail.search(
            authorization,
            GmailSearchInput.make({ ...input, toolCallId: context.toolCallId }),
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
      runGmail(options, Option.some(metadata.originatingAuthority), (gmail, authorization) =>
        gmail.sendApproved(authorization, input, metadata.allowancePeriodId),
      ),
  });

const runGmail = <A, E>(
  options: Options,
  originatingAuthority: Option.Option<OriginatingAuthority>,
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
      const authority = yield* loadCurrentAuthority(
        database,
        owner.userId,
        originatingAuthority.value,
        now,
      );
      if (authority === null) {
        return {
          _tag: "Denied",
          reason: "authorityRevoked",
          resetAt: null,
        } as const;
      }
      const billing = Billing.make(database);
      const current = yield* billing.admit(owner.userId, now);
      const gmailDb = GmailDb.make(database, (connection, operation) => {
        const auth = createAuth({
          baseURL: options.auth.baseURL,
          database,
          dashboard: { kind: "disabled" },
          google: {
            clientId: options.auth.google.clientId,
            clientSecret: Redacted.value(options.auth.google.clientSecret),
          },
          secret: Redacted.value(options.auth.secret),
          sendOTP: () => Promise.resolve(),
          trustedOrigins: [...options.auth.trustedOrigins],
          verifyOTP: () => Promise.resolve(false),
        });
        return Effect.tryPromise({
          try: () =>
            auth.api.getAccessToken({
              body: {
                accountId: connection.providerAccountId,
                providerId: "google",
                userId: connection.userId,
              },
            }),
          catch: (cause) =>
            new GmailProviderUnavailable({
              cause,
              message: "The owned Gmail OAuth access token could not be refreshed",
              operation,
            }),
        }).pipe(Effect.map(({ accessToken }) => Redacted.make(accessToken)));
      });
      const provider = yield* GmailApi.make({ credentials: gmailDb.credentials });
      const gmail = makeGmail({
        allowances: Allowances.make({
          billing,
          catalog: retainedCatalog,
          now: Effect.succeed(now),
        }),
        attempts: gmailDb.attempts,
        authorization: makeAuthorization(retainedCatalog),
        connections: gmailDb.connections,
        provider,
      });
      return yield* execute(
        gmail,
        currentGmailAuthorization(current, authority, originatingAuthority.value, now),
      );
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

const loadCurrentAuthority = (
  database: Database,
  userId: GmailAllowanceAdmission["userId"],
  origin: OriginatingAuthority,
  now: Date,
) => {
  if (Predicate.isTagged(origin, "DurableTrigger")) return Effect.succeed(null);
  if (Predicate.isTagged(origin, "ChannelBinding")) {
    return authorityQuery(() =>
      database
        .select({ channelBindingId: channelBindings.channelBindingId })
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.channelBindingId, origin.channelBindingId),
            eq(channelBindings.userId, userId),
            isNull(channelBindings.revokedAt),
          ),
        )
        .limit(1)
        .execute(),
    ).pipe(
      Effect.map(([current]) =>
        current === undefined
          ? null
          : ({
              _tag: "ChannelBinding",
              channelBindingId: origin.channelBindingId,
              userId,
            } as const),
      ),
    );
  }
  return authorityQuery(() =>
    database
      .select({ authSessionId: sessions.id, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, origin.authSessionId),
          eq(sessions.userId, userId),
          gt(sessions.expiresAt, now),
        ),
      )
      .limit(1)
      .execute(),
  ).pipe(
    Effect.map(([current]) =>
      current === undefined
        ? null
        : ({
            _tag: "AuthSession",
            authSessionId: origin.authSessionId,
            expiresAt: current.expiresAt,
            userId,
          } as const),
    ),
  );
};

const authorityQuery = <A>(query: () => Promise<ReadonlyArray<A>>) =>
  Effect.tryPromise({
    try: query,
    catch: (cause) =>
      new GmailPersistenceUnavailable({
        cause,
        message: "The originating Gmail authority could not be rechecked",
        operation: "findByUser",
      }),
  });

const currentGmailAuthorization = (
  current: GmailAllowanceAdmission,
  authority: NonNullable<AuthorizationContext["authority"]>,
  originatingAuthority: OriginatingAuthority,
  now: Date,
) =>
  AuthorizationContext.make({
    allowance: {
      _tag: "Metered",
      allowancePeriodId: current.allowancePeriodId,
      endsAt: current.endsAt,
      plan: current.plan,
      planPolicyVersion: current.planPolicyVersion,
      startsAt: current.startsAt,
      usage: current.usage,
    },
    approval: null,
    authority,
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    gmailConnection: null,
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 0n,
      retainedFileBytes: 0n,
    },
    now,
    originatingAuthority,
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: current.userId,
    subscription: {
      plan: current.plan,
      planPolicyVersion: current.planPolicyVersion,
    },
    user: { _tag: "ActiveUser", userId: current.userId },
  });
