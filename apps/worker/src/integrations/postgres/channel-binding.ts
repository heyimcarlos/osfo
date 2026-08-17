import { channelBindings } from "@osfo/db/schema/onboarding";
import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import * as Db from "../../db";
import type * as ChannelBinding from "../../services/channel-binding";

/** Build the current Channel Binding authority from application Postgres. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  return {
    inspect: (userId, channelBindingId) =>
      Db.execute("inspectChannelBinding", () =>
        database
          .select({ channelBindingId: channelBindings.channelBindingId })
          .from(channelBindings)
          .where(
            and(
              eq(channelBindings.channelBindingId, channelBindingId),
              eq(channelBindings.userId, userId),
              isNull(channelBindings.revokedAt),
            ),
          )
          .limit(1),
      ).pipe(
        Effect.map(([record]) =>
          record === undefined
            ? ({ _tag: "RevokedChannelBinding", channelBindingId, userId } as const)
            : ({ _tag: "ChannelBinding", channelBindingId, userId } as const),
        ),
      ),
  } satisfies ChannelBinding.Interface;
});
