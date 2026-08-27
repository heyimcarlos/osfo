# Consume a WhatsApp Wake-up

This drive proves that a registered User can return through one privacy-safe
WhatsApp Utility template without creating a second normal-message transport.

The production Wake-up source adapter intentionally remains fail-closed until the
source-owning tickets #180, #182, #186, and #190 provide their committed facts.
Until those adapters land, this browser drive is MISSING: do not manufacture source
rows or claim PASS from the final observer alone.

## Sub-features

- active WhatsApp Channel Link owned by the disposable User;
- fixed `en` or `es` variable-free Utility template accepted by the local Meta boundary;
- one inbound reply consuming the User latch before Think handling;
- source-owned committed results exposed in commit order;
- Channel Link revocation preventing later sends;
- permanent deletion leaving zero User Wake-up rows.

## Driving it with Chrome

1. Complete [registration](registration.md). Attempt [Telegram channel linking](channel-linking.md)
   exactly once in the same tab. If local Workers AI cannot produce the invite, retain the
   logs and record `verified-unreachable`; do not retry that provider-owned prerequisite.
2. Establish the run-owned WhatsApp Channel Link through the local webhook and browser invite.
   Internal row insertion does not qualify the link.
3. Seed two eligible committed source facts through their owning local adapters, with distinct
   commit times, and request one Wake-up. Start `whatsapp-wakeup` evidence; this also switches
   the local Meta emulator into fixed-template-only mode.
4. Require the local Meta ledger to contain exactly one `type: template` request using
   `osfo_update`, the persisted locale, and no components, parameters, media, buttons, URL,
   result text, or ordinary proactive `type: text` request.
5. Deliver one run-owned inbound WhatsApp reply. Require the two source-owned results to be
   exposed in commit order before the new normal response. Capture the ready state as
   `action.png` and the normal response as `result.png`.
6. Revoke the WhatsApp Channel Link, prove another eligible source creates no provider request,
   then complete [account deletion](account-deletion.md).
7. Run the observer and finish evidence.

PASS requires the exact fixed template shape; one provider acceptance; one consumed latch;
ordered owner exposure before Think; no template-created Think turn, history entry, allowance,
or User Usage Event; no send after revocation; and zero durable Wake-up rows after deletion.
Production Meta approval and closed-window qualification remain MISSING until #187 records them.
The finish command also requires feature-specific browser records for linked authority, ordered
source exposure, revocation with no later template, and permanent deletion; unrelated screenshots
or generic action/result notes cannot qualify this feature.
