# Osfo Context

Osfo defines reusable semantics for agent systems. Deployable products compose
Osfo without making their product-specific rules part of Osfo.

## Language

**Osfo**:
A reusable semantic foundation for building agent systems. Products depend on
Osfo; they do not define its domain.
_Avoid_: TryAgent backend, product application

**Product Composition**:
A deployable agent product that selects and constrains Osfo concepts for a
particular use case. TryAgent and the take-home application are separate product
compositions.
_Avoid_: Osfo instance, Osfo product

**Single-Thread Agent**:
An agent reached through one canonical ordered conversation, independent of the
devices used to participate in it. The term describes conversational identity,
not compute concurrency.
_Avoid_: Single-threaded process, one worker per agent

**Channel Endpoint**:
An external messaging address through which a person reaches a Single-Thread
Agent. The endpoint is a transport boundary, not the agent or its conversation.
_Avoid_: Agent identity, Thread

**Channel Edge**:
A Product Composition module that translates provider-specific channel traffic
to and from Osfo's transport-neutral conversation semantics. It does not own
the Thread or agent identity.
_Avoid_: Channel Endpoint, conversation store
