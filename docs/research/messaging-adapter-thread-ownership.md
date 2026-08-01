# Messaging adapters and Thread ownership

Research date: 2026-08-01. Hermes Agent repository evidence is pinned to
revision [`470cf66`](https://github.com/NousResearch/hermes-agent/tree/470cf66b039c73bdd2c21d43094ce41a4db74eae).

## Decision frame

- **Question**: should Osfo rely on messaging providers for conversation and
  device synchronization, and how should provider conversations relate to an
  Osfo `Thread`?
- **Conclusion**: providers should own their native multi-device user
  experience. Osfo must still own its durable agent conversation. A Product
  Composition maps an adapter-specific conversation key to an Osfo `ThreadId`.

```text
provider devices -> provider conversation -> Messaging Adapter -> Osfo Thread
```

## Hermes Agent

Hermes calls its integrations **platform adapters**. Each adapter routes an
incoming message through a per-chat session store before agent execution
([gateway overview](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/website/docs/user-guide/messaging/index.md)).

Sessions are keyed by platform plus provider chat, thread, and sometimes user
identity. A WhatsApp direct message, Discord direct message, and Telegram
direct message therefore do not share one session by default
([session-key table](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/website/docs/user-guide/sessions.md#per-platform-session-tracking)).
Hermes supports explicit cross-platform handoff by rebinding a destination
adapter key to an existing session. Sharing is a policy action, not an implicit
property of installing several adapters
([cross-platform handoff](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/website/docs/user-guide/sessions.md#cross-platform-handoff)).

Hermes does not connect directly to a public consumer iMessage bot API. Its
BlueBubbles adapter talks to an always-on macOS server through webhooks and a
REST interface
([BlueBubbles adapter setup](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/website/docs/user-guide/messaging/bluebubbles.md)).

## WhatsApp

WhatsApp synchronizes message history and application state across a user's
linked devices. Osfo does not need to reproduce that user-facing synchronization
for a WhatsApp-only Product Composition
([Meta's multi-device architecture](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/)).

The Business Platform exposes individual message identity and sender/business
identity rather than a durable Osfo-like conversation-log identity
([inbound message reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text/)).
Its customer-service window is a sending-policy interval, not an agent Thread
lifetime
([WhatsApp pricing and service windows](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/)).
Webhook delivery is retryable and can duplicate notifications, so the adapter
still requires durable ingestion and deduplication
([webhook delivery](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/)).

A useful default provider key is the business identity plus WhatsApp user
identity. The Product Composition maps that opaque key to a `ThreadId`.

## Apple Messages

Messages in iCloud keeps a user's message history synchronized across their
Apple devices
([Apple Messages in iCloud](https://support.apple.com/guide/icloud/keep-your-messages-up-to-date-with-icloud-mma17ed475f7/icloud)).
That removes any need for Osfo to synchronize those Apple clients itself.

Consumer iMessage does not provide a public unattended bot interface. Apple's
public Messages framework is for on-device extensions
([Messages framework](https://developer.apple.com/documentation/messages)).
Messages for Business integrations connect through an Apple-approved Messaging
Service Provider. Apple supplies a stable anonymous Opaque ID for a
customer-business relationship, but Apple does not retain the business
conversation history
([Messages for Business FAQ](https://register.apple.com/resources/messages/messaging-documentation/faq),
[Apple Platform Security](https://support.apple.com/guide/security/messages-for-business-security-sec1c603aab4/web)).

An Apple Messaging Adapter should map the provider's customer and conversation
identifiers into Osfo identity. They should not become Osfo's universal
`ThreadId`.

## Recommended model

Use **Messaging Adapter** for the concrete provider-specific Adapter. Keep the
provider identity separate from Osfo identity:

```text
(MessagingAdapterId, ProviderConversationKey)
                         |
                    explicit binding
                         v
                      ThreadId
```

- One provider conversation maps to one Thread by default.
- Several devices using that provider conversation still reach the same
  Thread because the provider presents one conversation identity to the
  adapter.
- Different Messaging Adapters create different Threads by default.
- Cross-adapter continuity requires explicit identity linking or handoff in the
  Product Composition.
- Direct web or mobile adapters use Osfo cursor replay because no messaging
  provider supplies synchronization. Provider messaging adapters use their
  provider's delivery mechanism and need not expose `ThreadCursor` to the end
  user.

Provider synchronization does not replace Osfo's durable Thread log. Providers
do not own Osfo's accepted-message, partial-output, tool, approval, workflow,
failure, and audit facts. Keeping the Thread authoritative also permits adapter
replacement, explicit handoff, replay after backend failure, and consistent
agent context independent of provider retention.
