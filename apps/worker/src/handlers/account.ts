import {
  AccountDeletionActionUnavailable,
  AccountDeletionCaller,
  AccountDeletionPresentationUnavailable,
  AccountDeletionUnavailable,
  Api,
  CurrentUser,
} from "@osfo/api";
import { Effect, Layer, Predicate } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { AccountDeletionRequestService } from "../composition/account-deletion-request";

/* oxlint-disable eslint/no-underscore-dangle -- The caller union uses the _tag discriminator. */

/** Implement the authenticated account-deletion contract. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const deletion = yield* AccountDeletionRequestService.make;
    return HttpApiBuilder.group(Api, "account", (handlers) =>
      handlers
        .handle("presentAccountDeletion", () =>
          Effect.gen(function* () {
            const currentUser = yield* CurrentUser;
            return yield* deletion.present({
              authSessionId: currentUser.authSessionId,
              userId: currentUser.userId,
            });
          }).pipe(
            Effect.mapError(
              () =>
                new AccountDeletionPresentationUnavailable({
                  message: "Account deletion could not be presented",
                }),
            ),
          ),
        )
        .handle("deleteAccount", ({ payload }) =>
          Effect.gen(function* () {
            const caller = yield* AccountDeletionCaller;
            if (caller._tag === "RetainedReplay") {
              yield* deletion.acknowledgeRetained(caller.userId, caller.deletionCaseId);
              return { status: "deletion-pending" as const };
            }
            yield* deletion.request({
              approval: payload.approval,
              authSessionId: caller.authSessionId,
              confirmation: payload.confirmation,
              presentationVersion: payload.presentationVersion,
              replayToken: payload.replayToken,
              userId: caller.userId,
            });
            return { status: "deletion-pending" as const };
          }).pipe(
            Effect.mapError((failure) =>
              Predicate.isTagged(failure, "AccountDeletionRequest.ActionUnavailable")
                ? new AccountDeletionActionUnavailable({
                    message: "Request a fresh account deletion confirmation",
                    requestState: "notAccepted",
                  })
                : new AccountDeletionUnavailable({
                    message: "Osfo could not confirm whether account deletion started",
                    requestState: "mayBeAccepted",
                  }),
            ),
          ),
        ),
    );
  }),
);

export * as AccountHandlers from "./account";
