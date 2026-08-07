# Current OpenPoke v1 demo architecture

Status: current selected topology on 2026-08-07. Production qualification is
still `MISSING`.

```mermaid
flowchart LR
  subgraph devices["Untrusted client boundary, horizontally many"]
    A["Device A, authenticated session, cursor A"]
    B["Device B, authenticated session, cursor B"]
    C["Device C, authenticated session, cursor C"]
  end

  subgraph edge["Public edge trust boundary, managed horizontal scale"]
    E["HTTPS edge and account authentication"]
  end

  subgraph app["Private application boundary, us-east4 candidate"]
    NTT["Native Thread Transport\nHTTP commands + cursor SSE\nhorizontally scalable"]
    RELAY["N1 relay\none active selector\nfour recoverable publishers\nsingleton role"]
    WORKERS["Fixed StreamingPull fleet\nsix-worker candidate\n4 streams and 32 slots per worker\nhorizontally replicated, manually sized"]
  end

  subgraph data["Durable data and delivery boundary"]
    PG[("PostgreSQL 17\ncanonical Thread and AgentRun authority\nreceipts, events, leases, epochs, outbox\none logical write primary")]
    PS[("One ordered Pub/Sub subscription\ndurable, non-authoritative delivery buffer")]
    ART[("Immutable artifact storage\nclient content bytes and digests")]
  end

  subgraph external["External provider trust boundary"]
    MODEL["Model and tool providers\nno Osfo recovery authority"]
  end

  A --> E
  B --> E
  C --> E
  E --> NTT
  NTT -->|"atomic admission and replay"| PG
  PG -. "LISTEN/NOTIFY wake hint plus safety recheck" .-> NTT
  PG -. "N1 wake hint" .-> RELAY
  RELAY -->|"confirmed minimal AgentRun identity"| PS
  PS -->|"ordered StreamingPull, at-least-once"| WORKERS
  WORKERS -->|"point claim, finite lease, monotonic epoch"| PG
  WORKERS --> MODEL
  WORKERS -->|"fenced outcomes and ThreadEvents"| PG
  WORKERS -->|"verified immutable export"| ART
  NTT -->|"replay first, then live SSE"| E
  E --> A
  E --> B
  E --> C
```

## Boundary legend

| Boundary | Contract |
| --- | --- |
| Trust | Every command and stream authenticates one Principal. Unknown and unauthorized Threads are indistinguishable. Provider responses are normalized before they cross into durable state. |
| Data | PostgreSQL is the only canonical Thread and AgentRun authority. Pub/Sub carries identities, not lifecycle state. Artifact storage owns immutable bytes only after digest and length verification. |
| Singleton | PostgreSQL has one logical write authority. The N1 relay has one active Principal-first selector. Neither role is hidden inside a web instance. |
| Horizontal scale | Edge and Native Thread Transport instances scale horizontally. StreamingPull workers are replicated, but the current fleet is fixed and manually sized so recovery does not depend on metric-triggered autoscaling. |

## Ordered calls

```text
authenticated HTTP command
  -> PostgreSQL transaction
       -> Acceptance Receipt, UserMessageAppended, AgentRun, capacity, outbox
  -> N1 relay selects a fair bounded window
  -> one ordered Pub/Sub subscription
  -> fixed StreamingPull worker point-claims PostgreSQL authority
  -> model or tool attempt runs outside the transaction
  -> fenced outcome and durable ThreadEvents commit
  -> Native Thread Transport replays after each device cursor
  -> live SSE follows the replay-to-live cut
```

Delivery is at least once. Authority is exactly one committed outcome under the
current claim epoch. A duplicate or out-of-order Pub/Sub delivery cannot create
new authority. A missed PostgreSQL notification can delay a wake, but the
safety recheck repairs it from canonical history.
