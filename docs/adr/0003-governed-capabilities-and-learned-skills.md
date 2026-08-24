# ADR 0003: Govern capabilities and learned Skills separately

Status: accepted

## Context

Osfo needs a broad personal-agent surface without turning every provider,
artifact format, or Skill into a Plan entitlement or monthly quota. Provider
tool registries and learned instructions are also not trustworthy sources of
User authority. A completed operation must remain reproducibly chargeable even
after provider prices, model routing, or product capabilities change.

## Decision

Free and Adventurer share one closed, versioned Capability Catalog. GM Summon is
the only Plan capability exception because it consumes human attention. Generic
integration and artifact operations replace provider- and format-specific
central policy. Integration Capability Manifests declare the allowlisted
provider operation, connection requirement, hard bounds, consequences,
exhausted eligibility, idempotency, and completed-evidence shape. Unknown
catalog entries, manifests, operations, and evidence deny.

Each Plan period pins an immutable Usage Policy Version. Each admitted operation
pins the current Resource Price, Model Access, Capability Catalog, and applicable
manifest versions. One final Usage Event records useful completed components
against its original period. Rating uses integer USD micros; actual Company Cost
and provider payloads remain outside the Plan Usage ledger.

User-visible capacity is one percentage-based Plan Usage pool. Post-consumption
recording is idempotent and may create a bounded internal negative balance;
later costly work pauses. Basic conversation, retained-data access, revocation,
deletion, export, billing, cancellation, and other safe management continue.

Skills are learned instructions, not authorization operations when selected or
used. User-triggered Skill lifecycle changes use the small `skill.inspect` and
`skill.manage` surface. Skill Learning is company-funded, evidence-checked, and
bounded independently of Plan Usage.

Cloudflare Dynamic Routing is the selected future execution plane. The current
direct Workers AI route remains active until compatibility, quality,
reconciliation, and economics evidence all pass. Missing evidence is a blocking
`MISSING` verdict, never an estimate.

## Consequences

- Adding a provider, Skill, Workflow, or artifact kind does not change central
  Usage Policy.
- Free can be useful across the whole self-serve product while Adventurer sells
  capacity and service strength instead of arbitrary feature gates.
- Historical charges and routes remain replayable through pinned versions.
- Authorization stays consequence-based and separate from provider consent,
  connection identity, model judgment, and cost.
- The policy surface is larger up front: manifests, price entries, qualification
  evidence, and economics inputs must be explicit before activation.
