import { AccountDeletionCaller, AccountDeletionUnavailable, Api, CurrentUser } from "@osfo/api";
import { getSessionCookie } from "better-auth/cookies";
import { Effect, Layer, Redacted } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { AccountDeletionRequest } from "../composition/account-deletion-request";

/* oxlint-disable eslint/no-underscore-dangle -- The caller union uses the _tag discriminator. */

/** Implement the authenticated account-deletion contract. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const deletion = yield* AccountDeletionRequest.make;
    return HttpApiBuilder.group(Api, "account", (handlers) =>
      handlers
        .handle("presentAccountDeletion", () =>
          Effect.gen(function* () {
            const currentUser = yield* CurrentUser;
            const request = yield* HttpServerRequest.HttpServerRequest;
            const source = request.source;
            if (!(source instanceof Request)) {
              return yield* new AccountDeletionUnavailable({
                message: "Account deletion could not be presented",
              });
            }
            const replaySessionCookie = getSessionCookie(source);
            if (replaySessionCookie === null) {
              return yield* new AccountDeletionUnavailable({
                message: "Account deletion could not be presented",
              });
            }
            return yield* deletion.present({
              authSessionId: currentUser.authSessionId,
              replaySessionCookie: Redacted.make(replaySessionCookie),
              userId: currentUser.userId,
            });
          }).pipe(
            Effect.mapError(
              () =>
                new AccountDeletionUnavailable({
                  message: "Account deletion could not be presented",
                }),
            ),
          ),
        )
        .handle("deleteAccount", ({ payload }) =>
          Effect.gen(function* () {
            const caller = yield* AccountDeletionCaller;
            if (caller._tag === "RetainedReplay") {
              yield* deletion.reconcileRetained(caller.userId);
              return { status: "deletion-pending" as const };
            }
            yield* deletion.request({
              approval: payload.approval,
              authSessionId: caller.authSessionId,
              confirmation: payload.confirmation,
              userId: caller.userId,
            });
            return { status: "deletion-pending" as const };
          }).pipe(
            Effect.mapError(
              () =>
                new AccountDeletionUnavailable({
                  message: "Account deletion could not be started",
                }),
            ),
          ),
        ),
    );
  }),
);

export * as AccountHandlers from "./account";
