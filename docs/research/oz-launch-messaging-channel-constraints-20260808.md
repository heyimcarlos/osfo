# Oz Launch Messaging Channel Constraints

Date: 2026-08-08

## Question

Can Oz safely launch as a general-purpose personal agent on WhatsApp, SMS/RCS,
or Apple Messages?

## Product Decision

Oz requires Apple Messages and WhatsApp as launch channels because the product
must live in the messaging applications its initial users already use. A web
or SMS-only launch does not prove the intended product.

WhatsApp is the initial launch platform. The project accepts the possibility
that an early channel account is suspended after launch and will treat channel
revocation as a contained product failure, not the loss of a user's Oz data or
identity. This posture does not authorize false representations or concealment
from a channel provider.

## Finding

Oz must not make global WhatsApp availability a launch dependency. Meta's
current WhatsApp Business Solution policy prohibits third-party
general-purpose AI assistants where their AI capability is the primary product
function. Regulatory intervention has produced regional exceptions, including
a temporary European exception, but that does not provide a stable global
product contract.

SMS is the most broadly available launch channel and does not impose the same
general-purpose assistant restriction. It introduces variable per-segment and
carrier cost, limited rich-media behavior, registration and consent work, and
potentially high cost for long assistant responses. RCS improves the rich
experience where available but still requires SMS fallback.

Apple's public Messages surfaces are not a direct general-purpose bot API.
Messages for Business is positioned for customer support, commerce, payments,
appointments, and authorized business updates. An iMessage app requires an
installed App Store application or extension, which does not satisfy Oz's
no-install messaging goal.

There are nevertheless two credible Apple Messages paths. Photon Spectrum
offers a TypeScript SDK plus managed shared or dedicated iMessage lines. A
maintained integration in Hermes provides additional implementation evidence,
but Hermes is explicitly excluded as the Oz foundation. Poke announced on
2026-06-04 that it had become a verified Apple Messages AI product. This proves
that a no-install Apple Messages product is possible, but not that Apple will
automatically approve Oz.

Hermes supports two distinct WhatsApp transports. Its Baileys transport is a
linked-device bridge for personal WhatsApp accounts, and Hermes explicitly
labels it unofficial with account-ban risk. Its Cloud API transport uses the
official WhatsApp Business Platform and therefore inherits Meta's business,
AI-provider, template, and pricing policies.

Poke is especially useful evidence. Its 2026-02-02 release notes state that
WhatsApp was temporarily unavailable outside Italy and Brazil after Meta's
policy change. Poke's current site again advertises WhatsApp, Apple Messages,
Telegram, and RCS, but its public documentation does not disclose the current
WhatsApp authorization or transport. Poke also warns that users may receive
messages from different numbers on different channels. A single Oz identity
therefore must not depend on one phone number being portable across every
channel.

## Cost Evidence

Twilio's Canadian long-code pricing on 2026-08-08 lists USD $0.0083 per inbound
or outbound SMS segment, plus outbound carrier fees of roughly USD $0.0064 to
$0.0087 per segment. A long AI answer may contain several billable segments.
The same page lists a Canadian long-code number at USD $1.15 per month, RCS
Basic at USD $0.0083, RCS Single at USD $0.022, and additional carrier fees.

These figures are provider and destination specific. The foundation comparison
must model channel cost from message segments, not conversational turns.

## Recommendation

Make WhatsApp technical viability an explicit launch gate and Apple Messages
viability an explicit second-channel gate before selecting Oz's application
foundation. Do not make prior Meta approval a prerequisite for a closed or
limited early release.

Prototype Apple Messages directly through Photon's TypeScript SDK, then
investigate direct Apple Messages for Business verification or a managed
provider relationship for production. Prototype WhatsApp through the official
Cloud API in a permitted region or approved account. If the early release uses
Baileys, use a dedicated replaceable Oz number, explicit user opt-in, strict
send limits, immediate opt-out handling, durable session backup, channel-health
monitoring, and a tested replacement-number procedure. Baileys remains an
unofficial transport with account-ban risk and must not be represented as Meta
authorization.

Keep the durable Oz identity independent from its channel addresses. One user
may reach the same Oz through different numbers or platform identifiers while
retaining one memory, permission set, trigger set, and conversation.

Treat WhatsApp ingress as shared always-on infrastructure rather than
per-user compute. Agent task sandboxes may remain temporary even though the
channel bridge and trigger dispatcher stay available continuously.

## Sources

- [European Commission press release on Meta's WhatsApp AI assistant policy](https://europa.eu/newsroom/ecpc-failover/pdf/ip-26-1276_en.pdf)
- [European Commission statement of objections](https://europa.eu/newsroom/ecpc-failover/pdf/ip-26-805_en.pdf)
- [Twilio Canada SMS and RCS pricing](https://www.twilio.com/en-us/sms/pricing/ca)
- [Apple Messages for Business and privacy](https://www.apple.com/legal/privacy/data/en/messages-for-business/)
- [Apple iMessage apps and Messages for Business](https://developer.apple.com/imessage/)
- [Meta's official WhatsApp Business Platform API collection](https://www.postman.com/meta/whatsapp-business-platform/overview)
- [Poke documentation](https://poke.com/docs)
- [Poke release notes](https://poke.com/docs/release-notes)
- [Poke messaging-number behavior](https://poke.com/faq)
- [Photon pricing and iMessage line models](https://photon.codes/pricing)
- [Hermes official and unofficial WhatsApp adapters](https://github.com/NousResearch/hermes-agent/tree/main/gateway/platforms)

## Confidence and Follow-up

Confidence is high that WhatsApp is not a stable global launch dependency and
that SMS pricing must be modeled per segment. Before implementation, legal and
commercial review must verify Meta's then-current terms, country exceptions,
AI-provider fees, approved use cases, and enforcement posture directly with
Meta or an authorized provider.
