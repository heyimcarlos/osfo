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
    E["External HTTPS load balancer + Cloud Armor\naccount authentication"]
  end

  subgraph app["Private application boundary, us-east4 candidate"]
    NTT["Public Cloud Run Native Thread Transport\nHTTP commands + cursor SSE\nhorizontally scalable"]
    RELAY["N1 relay\none active selector\nfour recoverable publishers\nsingleton role"]
    WORKERS["Fixed StreamingPull fleet\nsix-worker candidate\n4 streams and 32 slots per worker\nhorizontally replicated, manually sized"]
  end

  subgraph data["Managed durable-data boundary, us-east4 environment"]
    PG[("Cloud SQL for PostgreSQL 17\nregional HA, private IP + IAM DB auth\ncanonical Thread and AgentRun authority\none logical write primary")]
    PS[("Google Pub/Sub\nus-east4 environment and retention policy\none ordered pull subscription, 7-day unacked retention\nnon-authoritative delivery buffer")]
    ART[("Private GCS application-artifact bucket\nus-east4, content-addressed immutable bytes")]
    EVID[("Separate private GCS evidence bucket\nversioned qualification records and checksums")]
  end

  subgraph operations["Qualification trust boundary, no runtime authority"]
    QUAL["Qualification jobs and presentation tooling\nseparate evidence identity"]
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
  QUAL -. "bounded read-only evidence" .-> PG
  QUAL -->|"sealed evidence and reports"| EVID
  NTT -->|"replay first, then live SSE"| E
  E --> A
  E --> B
  E --> C
```

## Boundary legend

| Boundary | Contract |
| --- | --- |
| Trust | Every command and stream authenticates one Principal. Unknown and unauthorized Threads are indistinguishable. Provider responses are normalized before they cross into durable state. |
| Data | Regional-HA Cloud SQL for PostgreSQL in `us-east4` is the only canonical Thread and AgentRun authority and is reached by private IP with IAM database authentication. Pub/Sub follows the `us-east4` environment policy, carries identities rather than lifecycle state, and retains unacknowledged delivery for seven days. Private GCS application artifacts and versioned qualification evidence are separate storage roles. |
| Storage | The `us-east4` application-artifact bucket accepts content-addressed immutable bytes only after digest and length verification. Qualification jobs write checksummed records to a separate private, versioned evidence bucket; those records never become runtime authority. |
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
