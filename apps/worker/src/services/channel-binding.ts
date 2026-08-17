import type { Effect } from "effect";

import type { ChannelBindingId, UserId } from "../domain";
import type { DbUnavailable } from "../db";
import type { ChannelBindingAuthorityFact } from "../domain/channel-binding";

/** Current Channel Binding authority owned by application Postgres. */
export interface Interface {
  readonly inspect: (
    userId: UserId,
    channelBindingId: ChannelBindingId,
  ) => Effect.Effect<ChannelBindingAuthorityFact, DbUnavailable>;
}
