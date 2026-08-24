import { AccountDeletionUnavailable, Api, CurrentUser } from "@osfo/api";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { AccountDeletionRequest } from "../composition/account-deletion-request";
import type { AccountDeletionComposition } from "../composition/account-deletion";

/** Implement the authenticated account-deletion contract. */
export const layer = (bindings: AccountDeletionComposition.Bindings) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const deletion = yield* AccountDeletionRequest.make(bindings);
      return HttpApiBuilder.group(Api, "account", (handlers) =>
        handlers.handle("deleteAccount", ({ payload }) =>
          Effect.gen(function* () {
            const currentUser = yield* CurrentUser;
            yield* deletion.request({
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
