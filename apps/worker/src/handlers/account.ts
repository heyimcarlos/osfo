import { AccountDeletionUnavailable, Api, CurrentUser } from "@osfo/api";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { AccountDeletionRequest } from "../composition/account-deletion-request";

/** Implement the authenticated account-deletion contract. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const deletion = yield* AccountDeletionRequest.make;
    return HttpApiBuilder.group(Api, "account", (handlers) =>
      handlers
        .handle("presentAccountDeletion", () =>
          Effect.gen(function* () {
            const currentUser = yield* CurrentUser;
            return yield* deletion.present({ authSessionId: currentUser.authSessionId });
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
            const currentUser = yield* CurrentUser;
            yield* deletion.request({
              approval: payload.approval,
              authSessionId: currentUser.authSessionId,
              confirmation: payload.confirmation,
              userId: currentUser.userId,
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
