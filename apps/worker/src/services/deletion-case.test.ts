/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated service Layer. */
/* oxlint-disable eslint/no-underscore-dangle -- The assertion reads the domain outcome discriminator. */
import { BrowserCrypto } from "@effect/platform-browser";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { UserId } from "../domain";
import { ActionId } from "../domain/action-execution";
import { ApprovalPresentation } from "./authorization";
import { AuthSession } from "./auth-session";
import { DeletionCase } from "./deletion-case";

it.effect("persists the self-service fence before revoking every AuthSession", () => {
  const events: Array<string> = [];
  const userId = UserId.make("user-1");
  return Effect.gen(function* () {
    const service = yield* DeletionCase.make;
    const result = yield* service.requestSelf(userId, {
      actionId: ActionId.make("account-delete-1"),
      presentation: ApprovalPresentation.make("Delete account"),
    });

    expect(result._tag).toBe("DeletionRequested");
    expect(events).toEqual(["persist", "revoke"]);
  }).pipe(
    Effect.provide(BrowserCrypto.layer),
    Effect.provideService(
      AuthSession.Service,
      AuthSession.Service.of({
        inspect: () => Effect.die(new Error("unexpected inspection")),
        revoke: () => Effect.die(new Error("unexpected single revocation")),
        revokeAllForUser: () => Effect.sync(() => events.push("revoke")),
      }),
    ),
    Effect.provideService(
      DeletionCase.Persistence,
      DeletionCase.Persistence.of({
        inspect: () => Effect.succeed({ _tag: "DeletionAccessAvailable" }),
        request: () => Effect.die(new Error("unexpected administrative request")),
        requestSelf: (_userId, _deletionCaseId, approval) =>
          Effect.sync(() => {
            expect(approval).toEqual({
              actionId: "account-delete-1",
              presentation: "Delete account",
            });
            events.push("persist");
            return { _tag: "Created" as const };
          }),
      }),
    ),
  );
});
