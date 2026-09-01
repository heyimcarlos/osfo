# Continue a conversation with corrected Core Memory

This drive proves that one linked Telegram User can write and correct an Agent-owned Core Memory fact, replace the current Session with `/new`, and receive the corrected fact in the new Session. Registration and [Telegram channel linking](channel-linking.md) are prerequisites.

## Drive

1. Complete registration and Telegram channel linking in the current run. Start `conversation-memory` evidence. Read `provider_inbox_url`, `superseded_marker`, and `corrected_marker` from the feature's `metadata.txt`, then open that exact run-owned inbox URL in Chrome.
2. Deliver the ordinary message through the public Telegram webhook and refresh the inbox. Require a normal visible reply.

   ```sh
   ./.agents/skills/verify-osfo/helpers/control-osfo telegram-reply "$RUN_ID" \
     "Give me a normal run-owned reply for $RUN_ID."
   ```

3. Deliver the initial durable fact with the exact run-owned marker. Refresh the inbox and require the visible acknowledgement.

   ```sh
   ./.agents/skills/verify-osfo/helpers/control-osfo telegram-reply "$RUN_ID" \
     "Remember that my run-owned verification drink is spruce-soda-$RUN_ID."
   ```

4. Deliver the explicit correction. Keep `remember that` in the request so capability selection remains `core-memory`. Refresh the inbox and require the visible correction acknowledgement.

   ```sh
   ./.agents/skills/verify-osfo/helpers/control-osfo telegram-reply "$RUN_ID" \
     "Correction: remember that my run-owned verification drink is cedar-cocoa-$RUN_ID, not spruce-soda-$RUN_ID."
   ```

5. Deliver `/new`, refresh the inbox, and require the exact visible reply `Started a new Osfo session.` Capture the delivery history as `action.png`. Record the action with the exact summary below.

   ```sh
   ./.agents/skills/verify-osfo/helpers/control-osfo telegram-reply "$RUN_ID" /new
   ./.agents/skills/verify-osfo/helpers/control-osfo record "$RUN_ID" conversation-memory action \
     "ordinary Telegram reply and two Core Memory writes visible; Started a new Osfo session."
   ```

6. Ask the current-fact question. This wording intentionally avoids historical Session Recall phrases. Refresh the inbox. Require the answer to contain `cedar-cocoa-$RUN_ID` and exclude `spruce-soda-$RUN_ID`. Capture the delivery history as `result.png`, then record, observe, and finish.

   ```sh
   ./.agents/skills/verify-osfo/helpers/control-osfo telegram-reply "$RUN_ID" \
     "What is my run-owned verification drink?"
   ./.agents/skills/verify-osfo/helpers/control-osfo record "$RUN_ID" conversation-memory result \
     "corrected value visible and superseded value absent"
   ./.agents/skills/verify-osfo/helpers/control-osfo observe "$RUN_ID" conversation-memory
   ./.agents/skills/verify-osfo/helpers/control-osfo evidence "$RUN_ID" conversation-memory finish
   ```

## PASS

PASS requires both screenshots and browser records, plus direct evidence that:

- the linked User received an ordinary reply and the exact `/new` reply;
- the Agent was already registered and inspectable before conversation history was resolved;
- the route has one distinct historical Session containing exactly the three ordered User/assistant exchanges and both completed `set_context` traces;
- the model boundary's only tool selections were exactly two `set_context` calls: an initial `userContext` append followed by a `userContext` replacement containing only the corrected marker;
- the current Session contains only the two-message recall exchange; its answer contains the corrected marker and excludes the superseded marker;
- the final model request contains only the current recall User message, with the corrected fact as the sole User Context content and no superseded marker or copied historical turn;
- the model selected no `sessionRecall` tool; the successful empty local Supermemory profile and search calls immediately precede the final model request, and Supermemory retained no containers.

The model emulator may use only messages, system context, and available tools in its current request. A reply learned from emulator process state is a false positive.
