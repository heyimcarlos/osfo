---
status: accepted
---

# Serve unlinked senders with a temporary Company Conversation

An unlinked direct-message sender talks to Osfo itself in a bounded Company
Conversation instead of receiving only a deterministic Channel Link Invite. One
character reaches the public through two runtime partitions: before registration,
`CompanyAgent[addressKey]`; after, the User's private `OsfoAgent[agentId]`. The
class separation makes pre-registration privilege nonexistent by construction:
the company partition holds no User authority, memory, entitlements, or external
effects. Both partitions share one Osfo-owned persona policy; shared voice never
implies shared state.

The conversation runs on a fixed model route inside a bounded envelope: a capped
transcript window and an optional per-address daily turn ceiling. Its only
capability is a presentation request for the current invite. The model judges
when presenting the Channel Link Invite serves the person; deterministic code
asks ChannelLinks whether a live pending invite exists, mints one only when none
lives, and appends the verification URL after the model turn. Tokens and URLs
never enter model input, transcript, model output, logs, or errors. Duplicate
presentation requests collapse into one, and live-invite reuse bounds minting
while an invite remains valid. Group contexts stay deterministic and receive no
conversation or invite. Any private sender on a supported transport reaches the
conversation; provider allowlists do not gate it.

Conversation state stays address-keyed for the life of one linking attempt, so
fresh invite reissue spans one continuous conversation. Cleanup stays
expiry-only: teardown follows acceptance within hours and idleness within a day,
without transaction-backed cleanup obligations until real usage requires them.

Rejected alternatives: restoring `RegistrationDialogue` mixed registration with
linking authority; sharing the personal agent class behind mode branches leaves
every privileged path one missed check away from anonymous execution; eager
per-message invites rotate bearer material through every reply; a text marker
convention reimplements tool-call protocol poorly.

Consequences: product truth in `CONTEXT.md`, the v1 specification, and issue
#244 changes from deterministic-only contact to conversational contact. Future
capabilities such as web search join as restricted tools on the same surface.
Conversation continuity across acceptance remains deliberately unbuilt; the hard
cut at acceptance protects Native Memory until a designed handoff exists.
