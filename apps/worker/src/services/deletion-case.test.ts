/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated service Layer. */
/* oxlint-disable eslint/no-underscore-dangle -- The assertion reads the domain outcome discriminator. */
import { BrowserCrypto } from "@effect/platform-browser";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { PlanPolicyVersion, UserId } from "../domain";
import { AdminActorId, AdminReason } from "../domain/account-administration";
import { ActionId } from "../domain/action-execution";
import { AuthSessionId } from "../domain/auth-session";
import { DeletionCaseId } from "../domain/deletion-case";
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
          presentationVersion: "account-deletion-v1",
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
          authenticateSelfReplay: () => Effect.die(new Error("unexpected replay authentication")),
          inspect: () => Effect.succeed({ _tag: "DeletionAccessAvailable" }),
          markAccessFenced: () => Effect.die(new Error("unexpected administrative fence")),
          presentSelf: () => Effect.die(new Error("unexpected presentation")),
          request: () => Effect.die(new Error("unexpected administrative request")),
          requestSelf: (_userId, _deletionCaseId, approval, authority) =>
            Effect.sync(() => {
              expect(approval).toEqual({
                actionId: "account-delete-1",
                presentation: "Delete Account",
                presentationVersion: "account-deletion-v1",
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

it.effect("leaves AuthSessions untouched when a retained self-service case is not exact", () => {
  const events: Array<string> = [];
  return Effect.gen(function* () {
    const service = yield* DeletionCase.make;
    const result = yield* service.requestSelf(
      UserId.make("user-1"),
      {
        actionId: ActionId.make("new-action"),
        presentation: ApprovalPresentation.make("new-presentation"),
        presentationVersion: "account-deletion-v1",
      },
      {
        authSessionId: AuthSessionId.make("session-1"),
        plan: "free",
        planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
      },
    );

    expect(result).toEqual({ _tag: "DeletionAuthorityChanged" });
    expect(events).toEqual(["persist"]);
  }).pipe(
    Effect.provide(BrowserCrypto.layer),
    Effect.provideService(
      AuthSession.Service,
      AuthSession.Service.of({
        inspect: () => Effect.die(new Error("unexpected inspection")),
        revoke: () => Effect.die(new Error("unexpected single revocation")),
        revokeAllForUser: () =>
          Effect.sync(() => {
            events.push("revoke");
          }),
      }),
    ),
    Effect.provideService(
      DeletionCase.Persistence,
      DeletionCase.Persistence.of({
        authenticateSelfReplay: () => Effect.die(new Error("unexpected replay authentication")),
        inspect: () => Effect.succeed({ _tag: "DeletionAccessRevoked" }),
        markAccessFenced: () =>
          Effect.sync(() => {
            events.push("fence");
            return { _tag: "Fenced" as const };
          }),
        presentSelf: () => Effect.die(new Error("unexpected presentation")),
        request: () => Effect.die(new Error("unexpected administrative request")),
        requestSelf: () =>
          Effect.sync(() => {
            events.push("persist");
            return { _tag: "AuthorityChanged" as const };
          }),
      }),
    ),
  );
});

it.effect("leaves AuthSessions to the exact administrative persistence fence", () => {
  const userId = UserId.make("user-1");
  const retainedDeletionCaseId = DeletionCaseId.make("retained-case");
  const events: Array<string> = [];
  return Effect.gen(function* () {
    const service = yield* DeletionCase.make;
    const command = {
      adminActorId: AdminActorId.make("admin-1"),
      reason: AdminReason.make("Required erasure"),
      userId,
    };
    expect(yield* service.request(command)).toEqual({ _tag: "DeletionAuthorityChanged" });
    expect(events).toEqual(["request", "fence"]);
  }).pipe(
    Effect.provide(BrowserCrypto.layer),
    Effect.provideService(
      AuthSession.Service,
      AuthSession.Service.of({
        inspect: () => Effect.die(new Error("unexpected inspection")),
        revoke: () => Effect.die(new Error("unexpected single revocation")),
        revokeAllForUser: () => Effect.sync(() => events.push("external revoke")),
      }),
    ),
    Effect.provideService(
      DeletionCase.Persistence,
      DeletionCase.Persistence.of({
        authenticateSelfReplay: () => Effect.die(new Error("unexpected replay authentication")),
        inspect: () => Effect.succeed({ _tag: "DeletionAccessAvailable" }),
        markAccessFenced: (_command, deletionCaseId) =>
          Effect.sync(() => {
            expect(deletionCaseId).toBe(retainedDeletionCaseId);
            events.push("fence");
            return { _tag: "AuthorityChanged" as const };
          }),
        presentSelf: () => Effect.die(new Error("unexpected presentation")),
        request: () =>
          Effect.sync(() => {
            events.push("request");
            return { _tag: "Existing" as const, deletionCaseId: retainedDeletionCaseId };
          }),
        requestSelf: () => Effect.die(new Error("unexpected self-service request")),
      }),
    ),
  );
});
