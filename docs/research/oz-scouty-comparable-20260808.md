# Oz Comparable: Scouty

Date: 2026-08-08

## Product

Scouty is a narrow AI-powered event discovery and intelligence product. An
attendee opens a WhatsApp conversation, describes the events and outcomes they
care about, and receives proactive matching recommendations. Scouty says about
600 people currently use the product.

Scouty's interaction model is more relevant to Oz than its event-specific
features:

```text
click or scan -> WhatsApp conversation -> state the desired outcome
-> Scouty creates a durable brief -> Scouty monitors sources
-> Scouty sends a proactive match
```

Attendees do not download an app, create a separate login, or operate a
dashboard. Their messaging account may serve as their user identifier, and
initiating the chat records consent to receive event matches and related
messages. Scouty expects a later app only for capabilities WhatsApp handles
poorly, such as rich event browsing, calendar synchronization, and an inbox.

## Policy Position

Scouty is not a public example of a general-purpose assistant bypassing Meta's
AI-provider policy. Its terms define the primary service as event discovery
and intelligence. AI analyzes and matches event information as part of that
narrow service. This gives Scouty a materially different policy posture from
Oz even though both use conversational AI and proactive WhatsApp delivery.

Scouty's public terms and privacy policy disclose WhatsApp and other messaging
providers, AI processing, proactive recommendations, message storage, user
identification through messaging accounts, and user consent. They do not
identify the underlying WhatsApp transport or provider.

## Business Model

Scouty does not primarily monetize attendees. Attendee event discovery is
free. It charges event hosts and organizers through a 3 percent ticket fee on
the free plan, a USD $39 monthly Showrunner plan with USD $10 of AI credits,
and managed community services starting at USD $3,000 per month.

This means Scouty's free-user economics cannot be copied directly by Oz. Host
revenue subsidizes attendee research, matching, and WhatsApp delivery. Oz will
need a consumer subscription, usage limits, another subsidizing side of the
market, or a combination.

## Lessons for Oz

1. The first WhatsApp message should create a provisional Oz identity without
   requiring registration first.
2. Onboarding should ask what the user wants Oz to help with, not request a
   long configuration form.
3. Oz should prove proactivity immediately by creating one useful trigger or
   commitment during the first conversation.
4. Authentication links should appear only when a task requires Gmail,
   billing, account recovery, or another external connection.
5. WhatsApp should remain the normal interaction surface. A small web surface
   should own only flows that messaging cannot safely or clearly complete.
6. Messaging consent, opt-out, data use, and AI processing should be disclosed
   before proactive delivery begins.
7. A messaging-platform identifier may bootstrap an account, but it must not
   become the durable Oz identity or sole recovery credential.

## Sources

- [Scouty product](https://www.meetscouty.com/)
- [Scouty pricing](https://www.meetscouty.com/pricing)
- [Scouty host product](https://www.meetscouty.com/hosts)
- [Scouty terms](https://www.meetscouty.com/terms)
- [Scouty privacy policy](https://www.meetscouty.com/privacy)
