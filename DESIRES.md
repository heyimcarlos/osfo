# Ephemeral interactive UI generated from an Osfo conversation

Date captured: 2026-08-08
Horizon: after v2, not launch scope

Osfo could complement conversation with a temporary, authenticated interactive
surface assembled from trusted predefined components. A user might ask to
explore restaurants, compare choices, configure an order, or inspect another
structured result. Osfo would create a task-specific UI, send the user a private
link, receive the user's selections back into the same conversation, complete
any approved action, and retire the UI when it is no longer needed.

The long-term version could live directly inside a future Osfo chat application.
The nearer technical approximation could launch from WhatsApp into a private
web surface bound to the user's Osfo Account and the originating task.

This is a product direction to preserve, not a v1 or v2 commitment. Before it
becomes planned work, investigate component constraints, authorization,
accessibility, lifecycle and deletion, action approval, hostile generated
content, and whether the interaction materially improves on ordinary links or
documents.

# Agent capability request tool

Date captured: 2026-08-10
Horizon: design during tool-calling work

Give the agent a tool that reports a missing capability. The agent calls this
tool when a user asks it to do something that it cannot do because no suitable
tool or supported workflow exists. The report becomes an input to a feature
proposal list, where the team can review it and either plan the capability or
implement it.

The tool should capture enough context to make the request useful without
copying private conversation data by default. Candidate fields include the
requested outcome, the missing capability, the reason current tools cannot
complete it, the user impact, and a safe summary of the relevant context.

Before implementation, define how the agent distinguishes a real product gap
from a temporary tool failure, missing authorization, missing user input, or a
request that policy does not allow. Also define deduplication, privacy, user
visibility, review state, and the path from a report to a feature proposal.

# Simple website creation and deployment

Date captured: 2026-08-12
Horizon: future product direction

Let Osfo users create and deploy websites with very little setup. The experience
should feel as simple as products such as ChatGPT Sites and AMP Orbs: a user can
describe or build a site, publish it, and receive a working public URL without
needing to configure hosting infrastructure.

This is a future product desire, not a current commitment. Before it becomes
planned work, investigate site generation and editing, preview and publishing,
custom domains, authentication, storage, deployment isolation, abuse controls,
usage limits, observability, rollback, and ownership of generated content.

# Durable Think terminal evidence for post-commit consumers

Date captured: 2026-08-23
Horizon: upstream Think capability

Think should durably retain whether each persisted assistant message completed,
errored, or was aborted, or replay a post-commit hook until its consumer
acknowledges it. Think 0.15.1 persists the assistant message before exposing its
terminal status to `onChatResponse`, then does not retain a completed-versus-
aborted distinction that Osfo can recover after a Worker crash.

This would let durable consumers close the narrow crash window between Think's
message commit and their own local outbox transaction without treating aborted
output as completed. The capability should preserve Think history ownership and
avoid requiring a cross-database transaction.

## Private transport to provisioned browser hosts

Remote Workers need an authenticated private connection to the exact User-owned
Codex browser host. The initial inventory adapter supports same-machine local
development only; no remote transport, shared profile pool, or host provisioning
service exists. Keep preview and production disabled until this connection and
its ownership lifecycle are implemented and verified.
