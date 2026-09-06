# Consume a WhatsApp Wake-up

This drive proves that a registered User can create and change approved Reminders,
receive one privacy-safe WhatsApp Utility template for a due occurrence, and return
through the existing normal WhatsApp transport. Reminder bodies stay in Agent SQLite
and appear only inside the trusted Think turn after the User replies.

## Sub-features

- active WhatsApp Channel Link owned by the disposable User;
- fixed `en` or `es` variable-free Utility template accepted by the local Meta boundary;
- one inbound reply consuming the User latch before Think handling;
- one approved Free-plan one-time Reminder;
- one committed Reminder occurrence exposed exactly once to Think;
- Channel Link revocation preventing later sends;
- permanent deletion leaving zero User Wake-up rows.

## Driving it with Chrome

1. Complete [registration](registration.md). Attempt [Telegram channel linking](channel-linking.md)
   exactly once in the same tab. If local Workers AI cannot produce the invite, retain the
   logs and record `verified-unreachable`; do not retry that provider-owned prerequisite.
2. Run `control-osfo whatsapp-invite "$RUN_ID"`, open the printed invite in the same Chrome
   tab, and accept the run-owned WhatsApp Channel Link. Internal row insertion does not qualify.
3. Start `whatsapp-wakeup` evidence. This clears only the WhatsApp ledger and switches the
   local Meta emulator into fixed-template-only mode, so earlier link traffic cannot qualify.
4. In the normal Osfo conversation, ask for a one-time Reminder due 75-120 seconds in the
   future. Inspect the exact Action presentation and approve it, then immediately run
   `control-osfo record-reminder-due "$RUN_ID" "<the presentation's RFC 3339 due>"`. The helper
   accepts only an exact due 30 seconds to 10 minutes ahead and records it once. Ambiguous or
   invalid time input must fail before an Approval appears. The disposable User is on the Free
   launch-v1 plan, so recurring creation and material-change Approval remain deterministic
   module/runtime verification; do not seed an Adventurer subscription for this browser drive.
5. Wait for the one-time occurrence. Require the local Meta ledger to contain exactly one
   `type: template` request using
   `osfo_update`, the persisted locale, and no components, parameters, media, buttons, URL,
   result text, or ordinary proactive `type: text` request. Record the provider acceptance UTC
   timestamp, then run `control-osfo capture-reminder-occurrence "$RUN_ID"` before replying.
   The read-only Agent RPC observation machine-checks due-to-handler commit at no more than
   60 seconds; final observation machine-checks due-to-provider acceptance at no more than
   90 seconds.
6. Run `control-osfo whatsapp-reply "$RUN_ID" "What was my reminder?"`. Open its printed
   `provider_inbox_url` in Chrome, which selects `/inbox?channel=whatsapp` on this run's
   local provider. Refresh until the actual normal response appears as an
   **Accepted text message**. An accepted template, typing event, or rejected request
   cannot qualify as the normal response. Require the exact private one-time Reminder
   body to be present before the normal Think response, with no
   new claim on continuation; every continuation must retain the same claimed snapshot. Capture
   the approved/due state as `action.png` and the normal response as `result.png`, then run
   `control-osfo capture-reminder-think "$RUN_ID"`. Wait for the response and capture it
   before this command, because the observer restarts the Worker. The read-only Agent
   observation records the exact occurrence's exposure and single Think submission claim
   without exposing its body.
7. Revoke the WhatsApp Channel Link in Chrome. Create and approve another near-term one-time
   Reminder and prove its due occurrence creates no second template. Then complete
   [account deletion](account-deletion.md).
8. Run the observer and finish evidence.

PASS requires an exact one-time Reminder Approval presentation; the exact fixed template shape; one provider
acceptance within the SLO; one consumed latch; owner exposure before Think; no template-created
Think turn, history entry, allowance, or User Usage Event; no send after revocation; and permanent
deletion of the Agent, which removes its Reminder, occurrence, source, and schedule state together.
Production Meta approval and closed-window qualification remain MISSING until #187 records them.
The finish command also requires feature-specific browser records for linked authority, ordered
source exposure, revocation with no later template, and permanent deletion; unrelated screenshots
or generic action/result notes cannot qualify this feature.
