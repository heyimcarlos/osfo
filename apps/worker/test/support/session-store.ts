import { runInDurableObject } from "cloudflare:test";
import { Effect, Schema } from "effect";

import type { OsfoAgent } from "../../src/agents/osfo/agent";
import { makeAgentDb } from "../../src/agents/osfo/db/client";
import { makeAgentStore } from "../../src/agents/osfo/db/store";
import { DbTimestamp } from "../../src/db";
import type { ConversationRouteId, SessionId } from "../../src/domain";

/* oxlint-disable effecttsgo/async-function -- Cloudflare test helpers require a Promise callback. */

interface ReplaceOwnedSessionInput {
  readonly expectedCurrentSessionId: SessionId;
  readonly replacedAt: string;
  readonly replacementSessionId: SessionId;
  readonly routeId: ConversationRouteId;
}

/** Replace a Session through the private store seam for lifecycle integration setup. */
export const replaceOwnedSession = (
  agent: DurableObjectStub<OsfoAgent>,
  input: ReplaceOwnedSessionInput,
) =>
  runInDurableObject(agent, async (_instance, state) =>
    Effect.runPromise(
      Schema.decodeEffect(DbTimestamp)(input.replacedAt).pipe(
        Effect.map((replacedAt) => ({ ...input, replacedAt })),
        Effect.flatMap(makeAgentStore(makeAgentDb(state.storage)).replaceCurrentSession),
        Effect.match({
          onFailure: (failure) => failure,
          onSuccess: (replaced) => replaced,
        }),
      ),
    ),
  );
