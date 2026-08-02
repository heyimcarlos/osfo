# Cloud SQL mapping for the dispatch prototype

Research date: 2026-08-02. Cloud SQL products and prices change, so recheck the
linked Google Cloud documentation before provisioning.

## Decision

The local PostgreSQL container has an exact Cloud SQL resource-shape match:
Cloud SQL Enterprise, general purpose dedicated core,
`db-custom-4-4096`. This means 4 vCPU and 4 GiB memory. It is a capacity-label
match, not a performance-equivalence claim.

Do not add a read replica to the authoritative dispatch path. Admission,
Principal-first selection, `FOR UPDATE SKIP LOCKED`, lease takeover,
`claim_epoch` fencing, saturation counters, and completion all require current
state plus writes on one primary. A read replica is asynchronous, read-only,
and may lag.

For this local prototype, add a controlled database round-trip-time sensitivity
curve. Treat it as a latency sensitivity test, not Cloud SQL emulation. Validate
Cloud SQL itself later with an ephemeral, same-region managed run against both
zonal and regional HA instances.

```text
authoritative path

admission ----+
scheduler ----+----> Cloud SQL primary ----async WAL----> read replica
workers ------+              |                                |
                            writes                    stale-tolerant only
                                                       reports, analytics
```

## Local resource profile

The throwaway container currently fixes:

| Resource | Local setting |
| --- | ---: |
| PostgreSQL | 17.6 |
| CPU limit | 4 vCPU |
| Memory limit | 4 GiB |
| `max_connections` | 100 |
| `shared_buffers` | 1 GiB |
| `effective_cache_size` | 3 GiB |
| `work_mem` | 4 MiB |

Cloud SQL supports PostgreSQL 17 in both Enterprise and Enterprise Plus. For
PostgreSQL 16 and later, Enterprise Plus is the default, so an exact local
shape requires explicitly selecting Enterprise. Enterprise dedicated-core
custom shapes allow one vCPU or an even number from 2 to 96, memory from 0.9 to
6.5 GB per vCPU, 256 MB increments, and at least 3.75 GB. Custom names use
`db-custom-{CPUs}-{Memory}`. Therefore, `db-custom-4-4096` is the direct shape
mapping. See [machine series](https://docs.cloud.google.com/sql/docs/postgres/machine-series-overview),
[instance creation](https://docs.cloud.google.com/sql/docs/postgres/create-instance),
and the [edition comparison](https://docs.cloud.google.com/sql/docs/postgres/choose-edition).

At 3.75 GB to less than 6 GB of memory, Cloud SQL's default PostgreSQL
`max_connections` is 100. The local connection limit therefore matches the
managed default for this memory band. Cloud SQL defaults `shared_buffers` to
about one third of instance memory, while the local container uses one quarter.
A managed comparison should explicitly set it to 1 GiB if Cloud SQL accepts the
same flag value, or record the managed default as a known difference. See
[supported PostgreSQL flags](https://docs.cloud.google.com/sql/docs/postgres/flags)
and [Cloud SQL memory guidance](https://docs.cloud.google.com/sql/docs/postgres/manage-memory-usage-best-practices).

## Available Cloud SQL shapes

| Purpose | Edition and machine series | Shape | Comparison with local |
| --- | --- | --- | --- |
| Exact resource cap | Enterprise dedicated core | `db-custom-4-4096` | 4 vCPU, 4 GiB. Closest honest mapping. |
| Lower-cost floor | Enterprise dedicated core | `db-custom-2-3840` | Similar memory, half the CPU. Useful only as an intentionally smaller floor. |
| Modern Enterprise storage path | Enterprise N4 | `db-custom-N4-4-8192` | N4 requires at least 2 GB per vCPU, so 4 vCPU needs at least 8 GB. Uses Hyperdisk Balanced. |
| Enterprise Plus N2 | Enterprise Plus N2 | `db-perf-optimized-N-4` | 4 vCPU, 32 GB. Eight times the local memory. Uses SSD. |
| Enterprise Plus C4A | Enterprise Plus C4A | `db-c4a-highmem-4` | 4 vCPU, 32 GB. Eight times the local memory. Uses Hyperdisk Balanced. |

Shared-core `db-f1-micro` and `db-g1-small` instances are cheaper, but provide
only shared CPU and 0.614 GB or 1.7 GB memory. They are not comparable to the
local load profile and are not covered by the Cloud SQL SLA. Google also limits
some small tiers to low concurrent operation counts. They are suitable for a
connectivity smoke test, not dispatch-capacity evidence. See
[machine series](https://docs.cloud.google.com/sql/docs/postgres/machine-series-overview),
[Cloud SQL limits](https://docs.cloud.google.com/sql/docs/postgres/quotas), and
[Cloud SQL pricing](https://cloud.google.com/sql/pricing).

Storage remains a major unmatched variable. Cloud SQL SSD is network-attached
Persistent Disk, and its IOPS and throughput depend on machine type and
provisioned capacity. N4 and C4A use Hyperdisk Balanced, whose provisioned IOPS
and throughput behave differently. A 4 vCPU label and 4 GiB memory cap cannot
make a host-local Docker volume equivalent to either path. The managed test
must record storage type, size, IOPS, throughput, automatic-growth settings,
and observed disk latency. See [Cloud SQL storage options](https://docs.cloud.google.com/sql/docs/postgres/storage-options-overview).

## Cost frame

The lowest-cost credible managed capacity test is a short-lived, zonal Cloud
SQL Enterprise `db-custom-4-4096` instance, with a load generator in the same
region, deleted after all evidence is exported. Zonal availability is intended
for development and testing. A production destination should separately test
regional HA.

The current on-demand Enterprise general-purpose prices published for Toronto
and Montreal are USD $0.0454 per vCPU-hour and $0.0077 per GiB-hour. The exact
4 vCPU and 4 GiB shape is therefore about USD $0.2124 per hour, or $155.05 for
730 hours, compute and memory only. The published regional HA rates total about
$0.4252 per hour, or $310.40 for 730 hours. In Iowa, the published rates are
$0.0413 per vCPU-hour and $0.007 per GiB-hour, or about $0.1932 per hour and
$141.04 for 730 hours. These calculations omit storage, backups, networking,
Cloud DNS, logging, and taxes. Read replicas are charged as standalone
instances and add their own storage.

Iowa is not a useful saving if the application runs in Toronto. Saving roughly
$14 per month while adding inter-region latency changes the architecture being
tested. Choose the application region first, then place its database in the
same region.

The minimum Cloud SQL data disk is 10 GB. At Google's published starting SSD
price of $0.17 per GB-month, that is about $1.70 per month before regional
differences. Prices are region-specific and interactive, so use the official
[Cloud SQL pricing table](https://cloud.google.com/sql/pricing) and
[Google Cloud Pricing Calculator](https://cloud.google.com/products/calculator)
for a saved estimate. Committed-use discounts can lower steady-state compute
cost, but a one-year or three-year commitment is inappropriate for a throwaway
benchmark. See [Cloud SQL committed-use discounts](https://docs.cloud.google.com/sql/docs/postgres/cud)
and the [instance API disk limit](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances).

## Zonal, HA, and read replicas solve different problems

### Zonal

A zonal instance has no automatic cross-zone failover. It is the cheapest
managed shape for measuring the real Cloud SQL network, service scheduler,
storage, PostgreSQL flags, and connection behavior. It is not the final
durability profile.

### Regional HA

A regional HA instance has a primary and standby in different zones. Cloud SQL
synchronously replicates writes to persistent disks in both zones before
reporting commit, then automatically fails over when needed. The standby is not
a readable capacity pool. Google states that HA costs about twice a standalone
instance. See [Cloud SQL high availability](https://docs.cloud.google.com/sql/docs/postgres/high-availability).

For this dispatch topology, HA is a separate and important performance variant:
the synchronous cross-zone commit path can change admission and completion
latency. A local delay proxy cannot reproduce HA storage behavior or failover.

### Read replicas

Cloud SQL read replicas use PostgreSQL streaming replication and are
asynchronous, read-only copies. Cloud SQL does not automatically load balance
ordinary read replicas. Replica lag can come from primary WAL sending, network
transfer, or slow replay. Google recommends sizing a replica at least as large
as its primary, and warns that heavy or long-running replica queries can impede
replay. See [replication overview](https://docs.cloud.google.com/sql/docs/postgres/replication),
[creating a replica](https://docs.cloud.google.com/sql/docs/postgres/replication/create-replica),
and [replication lag](https://docs.cloud.google.com/sql/docs/postgres/replication/replication-lag).

Enterprise Plus read pools do not make queue decisions safe either. They can
serve traffic from a lagging node, and consecutive requests in one logical
session can reach nodes at different replay positions, making state appear to
move backward. See [Cloud SQL read pools](https://docs.cloud.google.com/sql/docs/postgres/about-read-pools).

The queue operations that must remain on the primary are:

- atomic admission and idempotency receipt creation;
- global and per-Principal saturation checks;
- Principal-first fairness counters and runnable selection;
- row locks and `FOR UPDATE SKIP LOCKED` claims;
- lease expiry, takeover, and monotonic `claim_epoch` changes;
- stale-worker fencing and authoritative completion;
- current queue depth used for admission or scheduling control.

A replica can serve only reads with explicit staleness tolerance:

- historical presentation queries and evidence exploration;
- long-range capacity trends and analytics;
- exported reports that display their data timestamp and replica lag;
- non-authoritative dashboards whose controls never feed scheduling or
  admission.

Moving those reads is worthwhile only if measurement shows they materially
contend with dispatch. A replica will not remove the exact primary-row lock
hotspot created by global capacity accounting. It also costs approximately one
additional standalone instance.

## Database round trips

The user's concern is correct. Localhost removes most network time. A managed
database adds a network round trip for each protocol exchange, not one round
trip per AgentRun. Transactions with several SQL statements can therefore
amplify a small per-round-trip delay. Connection pooling removes repeated
connection setup from steady-state requests but does not remove query round
trips.

Google recommends locating application compute and Cloud SQL in the same
region to reduce latency. Private IP keeps traffic on Google's network. A
direct private-IP connection has lower latency than a Cloud SQL connector,
while the Auth Proxy and language connectors simplify authentication and TLS.
Google publishes no fixed same-region RTT guarantee. See
[location guidance](https://docs.cloud.google.com/sql/docs/postgres/locations),
[private IP](https://docs.cloud.google.com/sql/docs/postgres/private-ip),
[connection choices](https://cloud.google.com/sql/docs/postgres/connect-overview),
and [connection pooling](https://docs.cloud.google.com/sql/docs/postgres/manage-connections).

For Rust and `sqlx`, Google does not publish a Rust Cloud SQL Language
Connector. The practical choices are a bounded `sqlx` pool over direct private
IP with TLS, or the Cloud SQL Auth Proxy plus that same bounded pool. The Auth
Proxy is a secure transport helper, not a database connection pool. See
[language connectors](https://docs.cloud.google.com/sql/docs/postgres/connect-connectors)
and [the Auth Proxy](https://docs.cloud.google.com/sql/docs/postgres/sql-proxy).

Managed Connection Pooling is Enterprise Plus only. Its default transaction
mode does not support `LISTEN` or session advisory locks, among other
session-scoped features. Since dispatch notifications are optional wake hints,
authoritative polling still works, but a notification listener would need a
dedicated session connection. This is not the lowest-cost baseline. See
[Managed Connection Pooling](https://docs.cloud.google.com/sql/docs/postgres/managed-connection-pooling).

## Experiment recommendation

### Add to the current local prototype

Keep the existing 4 vCPU, 4 GiB, 100-connection profile and add an explicit
network proxy between the harness and PostgreSQL. Apply the delay to database
traffic, not to synthetic provider work. Measure the actual pooled `SELECT 1`
RTT before each stage and run these sensitivity points:

| Injected database RTT | Purpose |
| ---: | --- |
| 0 ms | Existing localhost control |
| 1 ms | Very low same-region sensitivity |
| 3 ms | Moderate same-region sensitivity |
| 5 ms | Adverse same-region or connector sensitivity |
| 10 ms | Placement or network-path warning case |

These labels are hypotheses, not GCP RTT claims. The report should plot offered
rate, accepted rate, admission latency, claim latency, pending age, backlog,
lock waits, and drain time against measured RTT. Use the full human baseline at
each point. If 700 dispatches per second crosses a knee, concentrate the
proactive target around the two points on either side of that knee. Retain the
same bounded connection pool throughout.

If the proxy configures one-way delay separately in both directions, divide the
target RTT between the two directions and verify the observed value. Otherwise
the test can accidentally double the intended delay.

Do not describe any delayed local run as equivalent to Cloud SQL. It still
omits managed network storage, service scheduling, platform PostgreSQL
configuration, connector behavior, maintenance, synchronous HA commit, and
failover.

### Create separate managed Cloud SQL evidence

The smallest decision-useful managed matrix is:

1. Cloud SQL Enterprise, PostgreSQL 17, zonal `db-custom-4-4096`, same-region
   fixed load generator, private IP, direct TLS, SSD, and the same bounded
   connection pool.
2. The same shape as a regional HA instance to measure synchronous commit cost,
   failover, lost accepted work, backlog growth, and recovery.
3. A read replica only if the first two runs show that stale-tolerant dashboard
   or analytics reads materially compete with dispatch. Never send queue claims
   or lifecycle mutations to it.

For each managed run, persist the exact project-neutral environment metadata:
region, database version, edition, machine series and type, availability mode,
storage type and size, provisioned IOPS and throughput, database flags,
connection path, pool size, load-generator shape, measured RTT, and Cloud SQL
metrics. Export raw JSON or CSV plus the self-contained HTML report before
deleting the instance. A screenshot alone is not durable evidence.

Cloud SQL System Insights exposes query latency distributions, connections,
network traffic, and other database metrics useful for the presentation. See
[System Insights](https://docs.cloud.google.com/sql/docs/postgres/use-system-insights).

## Verdict

- `db-custom-4-4096` is the honest Cloud SQL resource mapping for the current
  local container.
- Equal offered load against local Docker and Cloud SQL is not an equitable
  performance comparison by itself.
- Add controlled 0, 1, 3, 5, and 10 ms database RTT sensitivity locally now.
- Do not add a replica to authoritative dispatch. It cannot share queue claims
  or lifecycle writes and introduces stale state.
- Run an ephemeral zonal managed comparison later, then repeat with regional HA.
  The HA result is the production-relevant durability and commit-latency test.
