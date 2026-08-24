import { expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import { ChannelLinkId, PlanPolicyVersion, UserId } from "../domain";
import { ActionId } from "../domain/action-execution";
import { ChannelAddress, ChannelAuthorId, ChannelId } from "../domain/channel-link";
import type { ManagedTurnAuthorityIdentity } from "../domain/managed-conversation";
import type { SessionRecallCurrentAuthorizationFacts } from "./session-recall-authorization";
import { ApprovalPresentation } from "./authorization";
import { makeManagedActionAuthorization } from "./managed-action-authorization";

/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect, vitest/no-standalone-expect -- Fixed authority time and assertions execute inside the @effect/vitest Effect callback. */

it.effect("reloads current authority immediately before an approved managed Action", () =>
  Effect.gen(function* () {
    const userId = UserId.make("managed-action-user");
    const channelLinkId = ChannelLinkId.make("managed-action-link");
    const identity: ManagedTurnAuthorityIdentity = {
      _tag: "ChannelLink",
      address: ChannelAddress.make({
        authorId: ChannelAuthorId.make("author-1"),
        channelId: ChannelId.make("channel-1"),
      }),
      channelLinkId,
      userId,
    };
    const current = yield* Ref.make<SessionRecallCurrentAuthorizationFacts>({
      authority: identity,
      deletionAccess: { _tag: "DeletionAccessAvailable" },
      now: new Date("2026-08-24T00:00:00.000Z"),
      resourceOwnerUserId: userId,
      subscription: { plan: "free", planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
      user: { _tag: "ActiveUser", userId },
    });
    const managedActions = makeManagedActionAuthorization({
      inspectAuthorization: () => Ref.get(current),
    });
    const operation = { actionId: ActionId.make("clear-memory-1"), kind: "memory.clear" } as const;
    const presentation = ApprovalPresentation.make("retained-presentation");

    expect(yield* managedActions.recheck(identity, operation, presentation)).toEqual({
      _tag: "Permitted",
    });

    yield* Ref.update(current, (facts) => ({
      ...facts,
      user: { _tag: "SuspendedUser" as const, userId },
    }));

    expect(yield* managedActions.recheck(identity, operation, presentation)).toEqual({
      _tag: "Denied",
      reason: "userSuspended",
      resetAt: null,
    });
  }),
);
