/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated service Layer. */
/* oxlint-disable eslint/no-underscore-dangle -- The assertion reads the domain outcome discriminator. */
import { BrowserCrypto } from "@effect/platform-browser";
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { PlanPolicyVersion, UserId } from "../domain";
import { AdminActorId, AdminReason } from "../domain/account-administration";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import type { DeletionCaseId } from "../domain/deletion-case";
import { ApprovalPresentation } from "./authorization";
import { AuthSession } from "./auth-session";
import { DeletionCase } from "./deletion-case";

it.effect(
  "delegates the self-service fence and AuthSession revocation to one persistence boundary",
  () => {
    const events: Array<string> = [];
    const userId = UserId.make("user-1");
    return Effect.gen(function* () {
      const service = yield* DeletionCase.make;
      const result = yield* service.requestSelf(
        userId,
        {
          actionId: ActionId.make("account-delete-1"),
          presentation: ApprovalPresentation.make("Delete Account"),
        },
        {
          authSessionId: AuthSessionId.make("session-1"),
          plan: "free",
          planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
        },
      );

      expect(result._tag).toBe("DeletionRequested");
      expect(events).toEqual(["persist"]);
    }).pipe(
      Effect.provide(BrowserCrypto.layer),
      Effect.provideService(
        AuthSession.Service,
        AuthSession.Service.of({
          inspect: () => Effect.die(new Error("unexpected inspection")),
          revoke: () => Effect.die(new Error("unexpected single revocation")),
          revokeAllForUser: () => Effect.die(new Error("self-service fence revoked separately")),
        }),
      ),
      Effect.provideService(
        DeletionCase.Persistence,
        DeletionCase.Persistence.of({
          inspect: () => Effect.succeed({ _tag: "DeletionAccessAvailable" }),
          markAccessFenced: () => Effect.die(new Error("unexpected administrative fence")),
          request: () => Effect.die(new Error("unexpected administrative request")),
          requestSelf: (_userId, _deletionCaseId, approval, authority) =>
            Effect.sync(() => {
              expect(approval).toEqual({
                actionId: "account-delete-1",
                presentation: "Delete Account",
              });
              expect(authority).toEqual({
                authSessionId: "session-1",
                plan: "free",
                planPolicyVersion: "launch-v1",
              });
              events.push("persist");
              return { _tag: "Created" as const };
            }),
        }),
      ),
    );
  },
);

it.effect("retries the AuthSession fence for a retained administrative Deletion Case", () => {
  const userId = UserId.make("user-1");
  let retainedDeletionCaseId: DeletionCaseId | null = null;
  let revocations = 0;
  const fencedCases: Array<DeletionCaseId> = [];
  return Effect.gen(function* () {
    const service = yield* DeletionCase.make;
    const command = {
      adminActorId: AdminActorId.make("admin-1"),
      reason: AdminReason.make("Required erasure"),
      userId,
    };
    const first = yield* service.request(command).pipe(Effect.result);
    expect(Result.isFailure(first)).toBe(true);

    const second = yield* service.request(command);
    expect(second).toEqual({
      _tag: "DeletionAlreadyRequested",
      deletionCaseId: retainedDeletionCaseId,
    });
    expect(revocations).toBe(2);
    expect(fencedCases).toEqual([retainedDeletionCaseId]);
  }).pipe(
    Effect.provide(BrowserCrypto.layer),
    Effect.provideService(
      AuthSession.Service,
      AuthSession.Service.of({
        inspect: () => Effect.die(new Error("unexpected inspection")),
        revoke: () => Effect.die(new Error("unexpected single revocation")),
        revokeAllForUser: () =>
          Effect.suspend(() => {
            revocations += 1;
            return revocations === 1
              ? Effect.fail(
                  new AuthSession.AuthSessionUnavailable({
                    cause: "temporary database failure",
                    message: "AuthSession fence unavailable",
                    operation: "revokeAll",
                  }),
                )
              : Effect.void;
          }),
      }),
    ),
    Effect.provideService(
      DeletionCase.Persistence,
      DeletionCase.Persistence.of({
        inspect: () => Effect.succeed({ _tag: "DeletionAccessAvailable" }),
        markAccessFenced: (_command, deletionCaseId) =>
          Effect.sync(() => {
            fencedCases.push(deletionCaseId);
            return { _tag: "Fenced" as const };
          }),
        request: (_command, deletionCaseId) =>
          Effect.sync(() => {
            if (retainedDeletionCaseId !== null) {
              return { _tag: "Existing" as const, deletionCaseId: retainedDeletionCaseId };
            }
            retainedDeletionCaseId = deletionCaseId;
            return { _tag: "Created" as const };
          }),
        requestSelf: () => Effect.die(new Error("unexpected self-service request")),
      }),
    ),
  );
});
