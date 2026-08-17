import { Effect, Predicate } from "effect";

import type { AllowancePeriodId, ToolCallId, UserId } from "../domain";
import type { AllowanceItem } from "../domain/allowance";
import {
  type GmailSendAttempt,
  type GmailSendEvidence,
  type GmailSendInput,
  type GmailSendRecoveryUnavailable,
  GmailAllowanceUnavailable,
  type GmailConnection,
  type GmailConnectionConflict,
  GmailConnectionId,
  type GmailConnectionStatus,
  type GmailDraftInput,
  type GmailPersistenceUnavailable,
  type GmailProviderUnavailable,
  type GmailReadEvidence,
  type GmailReadInput,
  type GmailSearchEvidence,
  type GmailSearchInput,
} from "../domain/gmail";
import {
  ambiguousActionResult,
  type ActionExecutionResult,
  type ActionId,
} from "../domain/action-execution";
import type { AuthorizationOperationInput } from "../domain/authorization-operation";
import type { AuthorizationContext, Denied, Interface as Authorization } from "./authorization";
import type { Interface as Allowances } from "./allowances";
import { ThinkApprovedActionExecution, executeThinkApprovedAction } from "./action-executor";

type ConnectedConnection = Extract<GmailConnection, { readonly _tag: "Connected" }>;

/** Narrow persistence port owned by the Gmail application service. */
export interface ConnectionPersistence {
  readonly completeOAuth: (
    userId: UserId,
    now: Date,
  ) => Effect.Effect<ConnectedConnection, GmailConnectionConflict | GmailPersistenceUnavailable>;
  readonly findById: (
    connectionId: GmailConnectionId,
  ) => Effect.Effect<GmailConnection | null, GmailPersistenceUnavailable>;
  readonly findByUser: (
    userId: UserId,
  ) => Effect.Effect<GmailConnection | null, GmailPersistenceUnavailable>;
  readonly revoke: (
    connection: ConnectedConnection,
    revokedAt: Date,
  ) => Effect.Effect<
    Extract<GmailConnection, { readonly _tag: "Revoked" }>,
    GmailPersistenceUnavailable
  >;
}

/** Dependencies for the Gmail application service. */
export interface MakeOptions {
  readonly allowances: Pick<Allowances, "record">;
  readonly attempts: SendAttemptPersistence;
  readonly authorization: Authorization;
  readonly connections: ConnectionPersistence;
  readonly provider: Provider;
  readonly reloadAuthorization: (
    previous: AuthorizationContext,
  ) => Effect.Effect<AuthorizationContext, GmailPersistenceUnavailable>;
}

/** Focused dependencies for Gmail connection control. */
export interface ConnectionControlOptions {
  readonly authorization: Authorization;
  readonly connections: ConnectionPersistence;
}

/** Gmail API operations required by the application service. */
export interface Provider {
  readonly prepareSend: (
    connection: ConnectedConnection,
    input: GmailSendInput,
  ) => Effect.Effect<PreparedGmailSend, GmailProviderUnavailable>;
  readonly read: (
    connection: ConnectedConnection,
    input: GmailReadInput,
  ) => Effect.Effect<GmailReadEvidence, GmailProviderUnavailable>;
  readonly search: (
    connection: ConnectedConnection,
    input: GmailSearchInput,
  ) => Effect.Effect<GmailSearchEvidence, GmailProviderUnavailable>;
  readonly reconcileSend: (
    connection: ConnectedConnection,
    input: GmailSendInput,
  ) => Effect.Effect<GmailSendEvidence, GmailProviderUnavailable>;
}

/** A fully prepared Gmail request whose only remaining operation is provider contact. */
export interface PreparedGmailSend {
  readonly contact: Effect.Effect<GmailSendEvidence>;
}

/** Gmail-specific provider recovery persistence, never Action or Approval authority. */
export interface SendAttemptPersistence {
  readonly recover: (
    actionId: ActionId,
    connectionId: GmailConnectionId,
    now: Date,
  ) => Effect.Effect<
    | { readonly _tag: "ActiveAttempt"; readonly attempt: GmailSendAttempt }
    | { readonly _tag: "ContactRecoveryStarted"; readonly attempt: GmailSendAttempt }
    | { readonly _tag: "PreparationRecoveryStarted"; readonly attempt: GmailSendAttempt }
    | { readonly _tag: "ExistingAttempt"; readonly attempt: GmailSendAttempt }
    | null,
    GmailSendRecoveryUnavailable
  >;
  readonly prepare: (
    actionId: ActionId,
    connectionId: GmailConnectionId,
    now: Date,
  ) => Effect.Effect<
    | { readonly _tag: "AttemptPrepared"; readonly attempt: GmailSendAttempt }
    | { readonly _tag: "ActiveAttempt"; readonly attempt: GmailSendAttempt }
    | { readonly _tag: "ContactRecoveryStarted"; readonly attempt: GmailSendAttempt }
    | { readonly _tag: "PreparationRecoveryStarted"; readonly attempt: GmailSendAttempt }
    | { readonly _tag: "ExistingAttempt"; readonly attempt: GmailSendAttempt },
    GmailSendRecoveryUnavailable
  >;
  readonly markContacted: (
    actionId: ActionId,
    contactedAt: Date,
  ) => Effect.Effect<void, GmailSendRecoveryUnavailable>;
  readonly complete: (
    actionId: ActionId,
    outcome: GmailSendAttempt["outcome"],
  ) => Effect.Effect<void, GmailSendRecoveryUnavailable>;
}

/** Construct Gmail connection control without mail-execution dependencies. */
export const makeConnectionControl = (options: ConnectionControlOptions) => ({
  authorizeConnect: (context: AuthorizationContext) => authorizeConnect(options, context),
  completeOAuth: (context: AuthorizationContext) =>
    Effect.gen(function* () {
      const admission = authorizeConnect(options, context);
      if (!Predicate.isTagged(admission, "Admitted")) return admission;
      return yield* options.connections.completeOAuth(context.user.userId, context.now);
    }),
  inspect: (context: AuthorizationContext) =>
    options.connections.findByUser(context.user.userId).pipe(
      Effect.map((connection): GmailConnectionStatus => {
        if (connection === null) return { _tag: "NotConnected", userId: context.user.userId };
        if (
          Predicate.isTagged(connection, "Connected") &&
          context.subscription.plan !== "adventurer"
        ) {
          return {
            _tag: "Dormant",
            connectionId: connection.connectionId,
            providerAccountId: connection.providerAccountId,
            userId: connection.userId,
          };
        }
        return connection;
      }),
    ),
  revokeCurrent: (context: AuthorizationContext) =>
    options.connections
      .findByUser(context.user.userId)
      .pipe(Effect.flatMap((connection) => revokeConnection(options, context, connection))),
});

const authorizeConnect = (options: ConnectionControlOptions, context: AuthorizationContext) =>
  options.authorization.admit(
    { ...context, resourceOwnerUserId: context.user.userId },
    connectionOperation(GmailConnectionId.make(`gmail:${context.user.userId}`), "connect"),
  );

/** Construct Gmail mail behavior and connection control. */
export const make = (options: MakeOptions) => ({
  ...makeConnectionControl(options),
  draft: (context: AuthorizationContext, input: GmailDraftInput) =>
    Effect.gen(function* () {
      const authorized = yield* admitConnected(options, context, input.toolCallId, "gmail.draft");
      if (!Predicate.isTagged(authorized, "GmailOperationAdmitted")) return authorized;
      return {
        _tag: "DraftCreatedLocally" as const,
        body: input.body,
        recipient: input.recipient,
        selectedResourceId: input.selectedResourceId,
        subject: input.subject,
      };
    }),
  read: (context: AuthorizationContext, input: GmailReadInput) =>
    Effect.gen(function* () {
      const authorized = yield* admitConnected(options, context, input.toolCallId, "gmail.read");
      if (!Predicate.isTagged(authorized, "GmailOperationAdmitted")) return authorized;
      const evidence = yield* options.provider.read(authorized.connection, input);
      yield* recordObservedUsage(
        options.allowances,
        authorized.allowancePeriodId,
        { sourceId: input.toolCallId, sourceType: "gmailRead" },
        [
          { allowanceKind: "gmailMessagesExamined", basis: "observed", quantity: 1n },
          ...vendorCost(evidence.vendorUsdMicros),
        ],
      );
      return {
        _tag: "MessageRead" as const,
        body: evidence.body,
        from: evidence.from,
        messageId: evidence.messageId,
        subject: evidence.subject,
      };
    }),
  revoke: (context: AuthorizationContext, connectionId: GmailConnectionId) =>
    options.connections
      .findById(connectionId)
      .pipe(Effect.flatMap((connection) => revokeConnection(options, context, connection))),
  search: (context: AuthorizationContext, input: GmailSearchInput) =>
    Effect.gen(function* () {
      const authorized = yield* admitConnected(options, context, input.toolCallId, "gmail.search");
      if (!Predicate.isTagged(authorized, "GmailOperationAdmitted")) return authorized;
      const evidence = yield* options.provider.search(authorized.connection, input);
      const examined: ReadonlyArray<AllowanceItem> =
        evidence.messages.length === 0
          ? []
          : [
              {
                allowanceKind: "gmailMessagesExamined",
                basis: "observed",
                quantity: BigInt(evidence.messages.length),
              },
            ];
      yield* recordObservedUsage(
        options.allowances,
        authorized.allowancePeriodId,
        { sourceId: input.toolCallId, sourceType: "gmailSearch" },
        [
          { allowanceKind: "gmailSearches", basis: "observed", quantity: 1n },
          ...examined,
          ...vendorCost(evidence.vendorUsdMicros),
        ],
      );
      return { _tag: "SearchCompleted" as const, messages: evidence.messages };
    }),
  sendApproved: (
    context: AuthorizationContext,
    input: GmailSendInput,
    admittedAllowancePeriodId: AllowancePeriodId,
  ) =>
    Effect.gen(function* () {
      const connection = yield* options.connections.findByUser(context.user.userId);
      if (connection === null || !Predicate.isTagged(connection, "Connected")) {
        return yield* executeApprovedSendRecheck(options, context, input, connection, () =>
          Effect.succeed(
            ambiguousActionResult(
              input.actionId,
              "The Gmail connection was unavailable after authorization",
            ),
          ),
        );
      }
      return yield* executeApprovedSendRecheck(options, context, input, connection, () =>
        sendWithRecovery(options, connection, input, admittedAllowancePeriodId, context),
      );
    }),
});

const sendWithRecovery = (
  options: MakeOptions,
  connection: ConnectedConnection,
  input: GmailSendInput,
  allowancePeriodId: AllowancePeriodId,
  previousContext: AuthorizationContext,
) =>
  Effect.gen(function* () {
    const recovery = yield* options.attempts.recover(
      input.actionId,
      connection.connectionId,
      previousContext.now,
    );
    if (recovery !== null && Predicate.isTagged(recovery, "ActiveAttempt")) {
      return ambiguousActionResult(
        input.actionId,
        "The Gmail provider contact is still active and cannot be duplicated",
      );
    }
    if (recovery !== null && Predicate.isTagged(recovery, "ExistingAttempt")) {
      return ambiguousActionResult(
        input.actionId,
        "Gmail provider recovery evidence already blocks another send",
      );
    }
    if (recovery !== null && Predicate.isTagged(recovery, "ContactRecoveryStarted")) {
      return yield* executeApprovedSendRecheck(options, previousContext, input, connection, () =>
        Effect.gen(function* () {
          const evidence = yield* options.provider.reconcileSend(connection, input);
          yield* recordSendUsage(options.allowances, allowancePeriodId, input, evidence);
          yield* options.attempts.complete(input.actionId, attemptOutcome(evidence));
          return actionResult(input.actionId, evidence);
        }),
      );
    }
    const preparation = yield* Effect.result(options.provider.prepareSend(connection, input));
    if (Predicate.isTagged(preparation, "Failure")) {
      return actionResult(input.actionId, {
        _tag: "NotApplied",
        evidence: "Gmail was not contacted because send preparation failed",
        vendorUsdMicros: 0n,
      });
    }
    const started =
      recovery ??
      (yield* options.attempts.prepare(
        input.actionId,
        connection.connectionId,
        previousContext.now,
      ));
    if (Predicate.isTagged(started, "ActiveAttempt")) {
      return ambiguousActionResult(
        input.actionId,
        "The Gmail provider contact is still active and cannot be duplicated",
      );
    }
    if (Predicate.isTagged(started, "ExistingAttempt")) {
      return ambiguousActionResult(
        input.actionId,
        "Gmail provider recovery evidence already blocks another send",
      );
    }
    if (Predicate.isTagged(started, "ContactRecoveryStarted")) {
      return yield* executeApprovedSendRecheck(options, previousContext, input, connection, () =>
        Effect.gen(function* () {
          const evidence = yield* options.provider.reconcileSend(connection, input);
          yield* recordSendUsage(options.allowances, allowancePeriodId, input, evidence);
          yield* options.attempts.complete(input.actionId, attemptOutcome(evidence));
          return actionResult(input.actionId, evidence);
        }),
      );
    }
    const result = yield* executeApprovedSendRecheck(
      options,
      previousContext,
      input,
      connection,
      (current) =>
        Effect.gen(function* () {
          yield* options.attempts.markContacted(input.actionId, current.now);
          const contacted = yield* preparation.success.contact;
          const evidence = Predicate.isTagged(contacted, "Ambiguous")
            ? yield* options.provider.reconcileSend(connection, input)
            : contacted;
          yield* recordSendUsage(options.allowances, allowancePeriodId, input, evidence);
          yield* options.attempts.complete(input.actionId, attemptOutcome(evidence));
          return actionResult(input.actionId, evidence);
        }),
    );
    return result;
  });

const executeApprovedSendRecheck = <E>(
  options: MakeOptions,
  previousContext: AuthorizationContext,
  input: GmailSendInput,
  connection: GmailConnection | null,
  contactProvider: (
    current: AuthorizationContext,
  ) => Effect.Effect<ActionExecutionResult | Denied, E>,
) =>
  options.reloadAuthorization(previousContext).pipe(
    Effect.flatMap((current) =>
      options.connections.findByUser(current.user.userId).pipe(
        Effect.flatMap((reloaded) => {
          const currentConnection =
            connection !== null && Predicate.isTagged(connection, "Connected")
              ? sameConnectedConnection(connection, reloaded)
                ? reloaded
                : null
              : reloaded;
          return executeThinkApprovedAction(
            options.authorization,
            {
              ...current,
              gmailConnection: projectConnectionAuthority(currentConnection),
              resourceOwnerUserId: currentConnection?.userId ?? null,
            },
            ThinkApprovedActionExecution.make({
              _tag: "ThinkApprovedActionExecution",
              actionId: input.actionId,
              operation: "gmail.send",
            }),
            () => contactProvider(current),
          );
        }),
      ),
    ),
  );

const sameConnectedConnection = (
  prepared: ConnectedConnection,
  current: GmailConnection | null,
): current is ConnectedConnection =>
  current !== null &&
  Predicate.isTagged(current, "Connected") &&
  current.connectionId === prepared.connectionId &&
  current.credentialReference === prepared.credentialReference &&
  current.providerAccountId === prepared.providerAccountId;

const recordSendUsage = (
  allowances: Pick<Allowances, "record">,
  allowancePeriodId: AllowancePeriodId,
  input: GmailSendInput,
  evidence: GmailSendEvidence,
) => {
  const basis: AllowanceItem["basis"] = Predicate.isTagged(evidence, "Ambiguous")
    ? "conservative"
    : "observed";
  const sent: ReadonlyArray<AllowanceItem> = Predicate.isTagged(evidence, "NotApplied")
    ? []
    : [{ allowanceKind: "gmailSends", basis, quantity: 1n }];
  return allowances.record(
    allowancePeriodId,
    { sourceId: input.actionId, sourceType: "gmailSend" },
    [
      ...sent,
      ...(evidence.vendorUsdMicros > 0n
        ? [{ allowanceKind: "vendorUsdMicros" as const, basis, quantity: evidence.vendorUsdMicros }]
        : []),
    ],
  );
};

const attemptOutcome = (evidence: GmailSendEvidence): GmailSendAttempt["outcome"] => {
  if (Predicate.isTagged(evidence, "Applied")) return "applied";
  if (Predicate.isTagged(evidence, "NotApplied")) return "notApplied";
  if (Predicate.isTagged(evidence, "Ambiguous")) return "ambiguous";
  return evidence satisfies never;
};

const actionResult = (actionId: ActionId, evidence: GmailSendEvidence): ActionExecutionResult => {
  if (Predicate.isTagged(evidence, "Applied")) {
    return {
      _tag: "Applied",
      actionId,
      evidence: evidence.evidence,
      providerOperationId: evidence.providerMessageId,
    };
  }
  if (Predicate.isTagged(evidence, "NotApplied")) {
    return { _tag: "NotApplied", actionId, evidence: evidence.evidence };
  }
  if (Predicate.isTagged(evidence, "Ambiguous")) {
    return ambiguousActionResult(actionId, evidence.evidence);
  }
  return evidence satisfies never;
};

const admitConnected = (
  options: MakeOptions,
  context: AuthorizationContext,
  actionId: string,
  operation: "gmail.draft" | "gmail.read" | "gmail.search" | "gmail.send",
) =>
  Effect.gen(function* () {
    const connection = yield* options.connections.findByUser(context.user.userId);
    const admission = options.authorization.admit(
      {
        ...context,
        gmailConnection: projectConnectionAuthority(connection),
        resourceOwnerUserId: connection?.userId ?? null,
      },
      { actionId, kind: operation },
    );
    if (!Predicate.isTagged(admission, "Admitted")) return admission;
    if (connection === null || !Predicate.isTagged(connection, "Connected")) {
      return { _tag: "Denied", reason: "integrationConnectionRequired", resetAt: null } as const;
    }
    if (!Predicate.isTagged(admission.allowancePeriod, "Metered")) {
      const allowanceOperation =
        operation === "gmail.draft"
          ? "draft"
          : operation === "gmail.read"
            ? "read"
            : operation === "gmail.search"
              ? "search"
              : "send";
      return yield* new GmailAllowanceUnavailable({
        message: "The Gmail operation has no admitted allowance period",
        operation: allowanceOperation,
      });
    }
    return {
      _tag: "GmailOperationAdmitted" as const,
      allowancePeriodId: admission.allowancePeriod.allowancePeriodId,
      connection,
    };
  });

const vendorCost = (quantity: bigint): ReadonlyArray<AllowanceItem> =>
  quantity > 0n ? [{ allowanceKind: "vendorUsdMicros", basis: "observed", quantity }] : [];

const projectConnectionAuthority = (
  connection: GmailConnection | null,
): AuthorizationContext["gmailConnection"] =>
  connection === null
    ? null
    : Predicate.isTagged(connection, "Connected")
      ? { _tag: "Connected", userId: connection.userId }
      : { _tag: "Revoked", userId: connection.userId };

const revokeConnection = (
  options: ConnectionControlOptions,
  context: AuthorizationContext,
  connection: GmailConnection | null,
) =>
  Effect.gen(function* () {
    const connectionId =
      connection?.connectionId ?? GmailConnectionId.make(`gmail:${context.user.userId}`);
    const admission = options.authorization.admit(
      { ...context, resourceOwnerUserId: connection?.userId ?? null },
      connectionOperation(connectionId, "revoke"),
    );
    if (!Predicate.isTagged(admission, "Admitted")) return admission;
    if (connection === null || Predicate.isTagged(connection, "Revoked")) {
      return connection === null
        ? ({ _tag: "Denied", reason: "ownershipRequired", resetAt: null } satisfies Denied)
        : connection;
    }
    return yield* options.connections.revoke(connection, context.now);
  });

const recordObservedUsage = (
  allowances: Pick<Allowances, "record">,
  allowancePeriodId: AllowancePeriodId,
  source: { readonly sourceId: ToolCallId; readonly sourceType: "gmailRead" | "gmailSearch" },
  items: ReadonlyArray<AllowanceItem>,
) => allowances.record(allowancePeriodId, source, items);

/** Gmail Integration Connection and on-demand operation interface. */
export type Interface = ReturnType<typeof make>;

const connectionOperation = (
  actionId: GmailConnectionId,
  change: "connect" | "revoke",
): AuthorizationOperationInput => ({
  actionId,
  change,
  kind: "gmail.connection.manage",
});
