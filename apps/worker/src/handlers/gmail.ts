import {
  Api,
  CurrentUser,
  GmailConnectionConflict as GmailConnectionConflictResponse,
  GmailConnectionDenied,
  type GmailConnectionResponse,
  GmailConnectionUnavailable,
  type CurrentUserValue,
} from "@osfo/api";
import { DateTime, Effect, Layer, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { UserId } from "../domain";
import { AuthSessionId } from "../domain/auth-session";
import type { GmailConnectionStatus } from "../domain/gmail";
import { retainedCatalog } from "../domain/plan-policy";
import * as Db from "../db";
import * as Billing from "../db/billing";
import * as GmailDb from "../db/gmail";
import {
  type AuthorizationContext,
  make as makeAuthorization,
  type ApprovalRequired,
  type Denied,
} from "../services/authorization";
import * as AuthorizationContextProjection from "../services/authorization-context";
import { makeConnectionControl } from "../services/gmail";

/** Implement the authenticated Gmail connection control-plane contract. */
export const layer = Layer.unwrap(
  Effect.map(Db.Db, (db) =>
    HttpApiBuilder.group(Api, "gmail", (handlers) =>
      handlers
        .handle("inspectConnection", () =>
          runConnection((gmail, context) => gmail.inspect(context)).pipe(
            Effect.provideService(Db.Db, db),
          ),
        )
        .handle("completeConnection", () =>
          runConnection((gmail, context) => gmail.completeOAuth(context)).pipe(
            Effect.provideService(Db.Db, db),
          ),
        )
        .handle("revokeConnection", () =>
          runConnection((gmail, context) => gmail.revokeCurrent(context)).pipe(
            Effect.provideService(Db.Db, db),
          ),
        ),
    ),
  ),
);

type ConnectionResult = GmailConnectionStatus | ApprovalRequired | Denied;

const runConnection = <E>(
  execute: (
    gmail: ReturnType<typeof makeConnectionControl>,
    context: AuthorizationContext,
  ) => Effect.Effect<ConnectionResult, E>,
) =>
  Effect.gen(function* () {
    const currentUser = yield* CurrentUser;
    const database = yield* Db.database;
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const billing = Billing.make(database);
    const admission = yield* billing.admit(UserId.make(currentUser.userId), now);
    const gmailDb = GmailDb.make(database);
    const gmail = makeConnectionControl({
      authorization: makeAuthorization(retainedCatalog),
      connections: gmailDb.connections,
    });
    const result = yield* execute(gmail, connectionAuthorization(currentUser, admission, now));
    if (Predicate.isTagged(result, "Denied") || Predicate.isTagged(result, "ApprovalRequired")) {
      return yield* new GmailConnectionDenied({
        reason: Predicate.isTagged(result, "Denied") ? result.reason : "approvalRequired",
      });
    }
    return toResponse(result);
  }).pipe(
    Effect.mapError((failure) =>
      Schema.is(GmailConnectionDenied)(failure)
        ? failure
        : Predicate.isTagged(failure, "GmailConnectionConflict")
          ? new GmailConnectionConflictResponse({ reason: "connectionConflict" })
          : new GmailConnectionUnavailable({
              message: "The Gmail connection is temporarily unavailable",
            }),
    ),
  );

const connectionAuthorization = (
  currentUser: CurrentUserValue,
  admission: Effect.Success<ReturnType<Billing.Interface["admit"]>>,
  now: Date,
) =>
  AuthorizationContextProjection.project({
    allowance: {
      _tag: "Metered",
      allowancePeriodId: admission.allowancePeriodId,
      endsAt: admission.endsAt,
      plan: admission.plan,
      planPolicyVersion: admission.planPolicyVersion,
      startsAt: admission.startsAt,
      usage: admission.usage,
    },
    authority: {
      _tag: "AuthSession",
      authSessionId: AuthSessionId.make(currentUser.authSessionId),
      expiresAt: currentUser.authSessionExpiresAt,
      userId: UserId.make(currentUser.userId),
    },
    now,
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: AuthSessionId.make(currentUser.authSessionId),
    },
    plan: admission.plan,
    planPolicyVersion: admission.planPolicyVersion,
    userId: UserId.make(currentUser.userId),
  });

const toResponse = (status: GmailConnectionStatus): GmailConnectionResponse => {
  if (Predicate.isTagged(status, "NotConnected")) {
    return { connectionId: null, providerAccountId: null, status: "notConnected" };
  }
  return {
    connectionId: status.connectionId,
    providerAccountId: status.providerAccountId,
    status: Predicate.isTagged(status, "Connected")
      ? "connected"
      : Predicate.isTagged(status, "Dormant")
        ? "dormant"
        : "revoked",
  };
};
