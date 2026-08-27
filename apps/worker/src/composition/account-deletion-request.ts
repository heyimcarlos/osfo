import {
  AccountDeletionActionPresentation,
  type AccountDeletionPresentationVersion,
  AccountDeletionReplayToken,
  AccountDeletionRequest,
  accountDeletionPresentationDefinitions,
} from "@osfo/api";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { eq } from "drizzle-orm";
import { Crypto, DateTime, Effect, Encoding, Option, Predicate, Redacted, Schema } from "effect";

import { Db } from "../db";
import { PlanPolicyVersion, UserId } from "../domain";
import { AuthSessionId } from "../domain/auth-session";
import { ActionId } from "../domain/action-execution";
import { DeletionCaseId } from "../domain/deletion-case";
import { retainedCatalog } from "../domain/plan-policy";
import { AccountDeletion } from "../services/account-deletion";
import { DeletionCase } from "../services/deletion-case";
import {
  approvalFor,
  ApprovalPresentation,
  Authorization,
  AuthorizationContext,
  emptyLiveResourceFacts,
} from "../services/authorization";
import { AccountAuthorities } from "./account-authorities";

/** Compose the complete self-service account-deletion workflow behind the HTTP boundary. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  const authorities = yield* AccountAuthorities.make;
  const crypto = yield* Crypto.Crypto;
  const deletion = yield* AccountDeletion.Service;
  const present = Effect.fn("AccountDeletionRequest.present")(function* (input: {
    readonly authSessionId: string;
    readonly userId: string;
  }) {
    const userId = UserId.make(input.userId);
    const authSessionId = AuthSessionId.make(input.authSessionId);
    const actionId = ActionId.make(
      `account-delete:${yield* crypto.randomUUIDv7.pipe(
        Effect.mapError(() => unavailable("presentIdentity")),
      )}`,
    );
    const presentation = accountDeletionPresentation(actionId);
    const replayToken = yield* crypto.randomBytes(32).pipe(
      Effect.map((bytes) => Encoding.encodeBase64Url(bytes)),
      Effect.map((encoded) => AccountDeletionReplayToken.make(encoded)),
      Effect.mapError(() => unavailable("presentIdentity")),
    );
    const now = yield* DateTime.now;
    const result = yield* authorities.deletionCases.presentSelf(userId, {
      actionId,
      authSessionId,
      expiresAt: DateTime.toDateUtc(DateTime.add(now, { minutes: 5 })),
      presentation: ApprovalPresentation.make(encodeAccountDeletionPresentation(presentation)),
      presentationVersion: accountDeletionPresentationVersion,
      replayTokenHash: yield* DeletionCase.hashReplayToken(crypto, Redacted.make(replayToken)),
    });
    if (!Predicate.isTagged(result, "Presented")) return yield* unavailable("presentAuthority");
    return {
      presentation,
      presentationVersion: accountDeletionPresentationVersion,
      replayToken,
    } as const;
  });
  const request = Effect.fn("AccountDeletionRequest.request")(function* (input: {
    readonly approval: {
      readonly decision: "approved";
      readonly presentation: AccountDeletionPresentation;
    };
    readonly authSessionId: string;
    readonly confirmation: string;
    readonly presentationVersion: string;
    readonly replayToken: string;
    readonly userId: string;
  }) {
    const userId = UserId.make(input.userId);
    const authSessionId = AuthSessionId.make(input.authSessionId);
    const exactRequest = decodeExactRequest(input);
    if (Option.isNone(exactRequest)) {
      return yield* unavailable("approvalPresentation");
    }
    const expectedPresentation = exactRequest.value.approval.presentation;
    const presentation = ApprovalPresentation.make(
      encodeAccountDeletionPresentation(expectedPresentation),
    );
    const operation = {
      actionId: ActionId.make(expectedPresentation.actionId),
      kind: "account.delete",
    } as const;
    const [authority, deletionAccess, subscriptionRows, user, now] = yield* Effect.all([
      authorities.authSessions.inspect(userId, authSessionId),
      authorities.deletionCases.inspect(userId),
      Db.execute("inspectBillingSubscription", () =>
        database
          .select({
            plan: billingSubscriptions.plan,
            planPolicyVersion: billingSubscriptions.plan_policy_version,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.user_id, userId))
          .limit(1),
      ),
      authorities.userSuspensions.inspect(userId),
      DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    ]);
    const subscription = subscriptionRows[0];
    if (subscription === undefined) return yield* unavailable("authorize");
    const admission = Authorization.make(retainedCatalog).admit(
      AuthorizationContext.make({
        allowance: { _tag: "Unavailable" },
        approval: approvalFor(userId, operation, presentation),
        authority,
        deletionAccess,
        gmailConnection: null,
        integrationConnections: [],
        liveFacts: emptyLiveResourceFacts,
        now,
        originatingAuthority: { _tag: "AuthSession", authSessionId },
        requestVendorUsdMicros: 0n,
        resourceOwnerUserId: userId,
        subscription: {
          plan: subscription.plan,
          planPolicyVersion: PlanPolicyVersion.make(subscription.planPolicyVersion),
        },
        user,
      }),
      operation,
    );
    if (!Predicate.isTagged(admission, "Admitted")) return yield* unavailable("authorize");
    const requested = yield* authorities.deletionCases.requestSelf(
      userId,
      {
        actionId: operation.actionId,
        presentation,
        presentationVersion: exactRequest.value.presentationVersion,
        replayTokenHash: yield* DeletionCase.hashReplayToken(
          crypto,
          Redacted.make(exactRequest.value.replayToken),
        ),
      },
      {
        authSessionId,
        plan: subscription.plan,
        planPolicyVersion: PlanPolicyVersion.make(subscription.planPolicyVersion),
      },
    );
    if (
      Predicate.isTagged(requested, "DeletionRequested") ||
      Predicate.isTagged(requested, "DeletionAlreadyRequested")
    ) {
      // The request returns only after ordinary Agent work cannot cross the durable
      // access fence. Scheduled reconciliation still owns irreversible deletion.
      yield* deletion.quiesceCase(userId, requested.deletionCaseId);
      return undefined;
    }
    return yield* unavailable("fence");
  });
  const acknowledgeRetained = Effect.fn("AccountDeletionRequest.acknowledgeRetained")(function* (
    userId: string,
    deletionCaseId: string,
  ) {
    yield* deletion.quiesceCase(UserId.make(userId), DeletionCaseId.make(deletionCaseId));
  });
  return { acknowledgeRetained, present, request };
});

type AccountDeletionPresentation = AccountDeletionActionPresentation;

export const accountDeletionPresentationVersion =
  "account-deletion-v2" satisfies AccountDeletionPresentationVersion;
const accountDeletionActionDefinition =
  accountDeletionPresentationDefinitions[accountDeletionPresentationVersion];

const encodeAccountDeletionPresentation = Schema.encodeSync(
  Schema.fromJsonString(AccountDeletionActionPresentation),
);

export const accountDeletionPresentation = (actionId: ActionId) => ({
  actionId,
  ...accountDeletionActionDefinition,
});

/** Decode the exact retained approval fields allowed to authenticate a post-revocation retry. */
interface AccountDeletionReplayCandidate {
  readonly approval: {
    readonly presentation: AccountDeletionActionPresentation;
  };
  readonly confirmation: string;
  readonly presentationVersion: string;
  readonly replayToken: string;
}

export const replayApproval = (received: AccountDeletionReplayCandidate) =>
  Option.map(decodeExactRequest(received), (exact) => ({
    actionId: ActionId.make(exact.approval.presentation.actionId),
    presentation: ApprovalPresentation.make(
      encodeAccountDeletionPresentation(exact.approval.presentation),
    ),
    presentationVersion: exact.presentationVersion,
    replayToken: exact.replayToken,
  }));

const decodeExactRequest = Schema.decodeUnknownOption(AccountDeletionRequest);

const unavailable = (operation: string) =>
  new AccountDeletion.AccountDeletionUnavailable({
    cause: operation,
    message: "Account deletion could not be started",
    operation,
  });

export * as AccountDeletionRequestService from "./account-deletion-request";
