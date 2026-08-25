# Link a Telegram channel

Channel linking binds one private Telegram address to the registered User after the User accepts a bearer invitation in the web UI.

## Sub-features

- private Telegram webhook delivery;
- unlinked Company Conversation routing;
- provider reply containing a private invite;
- authenticated invite inspection and acceptance;
- accepted invite, active Channel Link, and audit event.

## How to get to it (user POV)

Send Osfo a private Telegram message from the address to link. Open the private invite in the reply while signed in, review `Connect this chat`, and choose `Link this channel`.

## Driving it with Chrome

1. Complete [registration](registration.md) and keep that Chrome tab signed in.
2. Run `control-osfo channel-invite <run-id>`. This delivers a run-owned direct message through `/webhooks/telegram` and prints the invite returned through the local Bot API boundary.
3. Start channel-linking evidence and open the invite in the same tab.
4. Wait for `Connect this chat`, capture the enabled `Link this channel` button as `action.png`, then choose it.
5. Wait for `Channel linked` and capture `result.png`.
6. Record both screenshots, run `observe channel-linking`, and finish the evidence.

## Gotchas

- Opening the invite in a signed-out tab starts phone verification. That is supported, but it is not the shortest review path after registration.
- Invite generation uses the Company Conversation's Workers AI tool choice. If local Workers AI lacks Cloudflare credentials or availability, preserve the Worker log and report the exact external prerequisite as `verified-unreachable`.
- The Telegram emulator is a production-boundary adapter. An inserted invite row is an internal shortcut and does not prove this path.
- `Connect this chat` proves only that the invite is pending. Require the `Channel linked` result and accepted durable state.
- One invite is single-use. Start a new run after a failed or consumed attempt.
