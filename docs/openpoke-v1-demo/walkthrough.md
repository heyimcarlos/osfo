# OpenPoke v1 walkthrough

## Part 1: What was built and why

Start with the user journey: device A sends one authenticated message, closes
mid-response, and device B later resumes from its own last ThreadCursor. Every
device is a view of one canonical Thread. Device identity never becomes
conversation authority.

The protocol is ordinary authenticated HTTP for commands and cursor-based SSE
for replay followed by live delivery. SSE fits the one-way server stream and
keeps command retries separate. A reconnect sends the last durably applied
opaque cursor. PostgreSQL returns later ThreadEvents in ThreadPosition order.
Stable event identities make at-least-once replay duplicate-safe.

The durable command path is:

```text
HTTP admission
  -> one PostgreSQL transaction
  -> append-oriented outbox
  -> N1 Principal-first relay
  -> one ordered Pub/Sub subscription
  -> fixed StreamingPull worker point claim
  -> fenced execution
  -> durable ThreadEvents
  -> cursor replay and live SSE
```

PostgreSQL owns receipts, canonical Thread history, AgentRun lifecycle, leases,
epochs, budgets, and outbox obligations. Pub/Sub is a durable delivery buffer,
not authority. Direct dual-write was rejected because database-first strands
work and publish-first can create ghost work. Authenticated Pub/Sub push was a
historical candidate. The selected worker delivery seam is now fixed
StreamingPull because work can outlive an HTTP request and the warm fixed fleet
has predictable recovery capacity.

The presentation packet includes the current architecture, exact 100k-DAU
arithmetic, copied records from sealed load and failure lanes, five sealed v16
Grafana views, and a verifier that fails closed on absent or changed artifacts.
Every gate stays `PASS`, `FAIL`, or `MISSING` at its measured scope.

## Part 2: What failed or was skipped, and how to test it

The second 30-minute Montreal repetition accepted and reconciled all work, but
the receipt gate failed: 9,105 of 417,600 receipts exceeded 1 second. That is a
2.18031609% late rate. Correctness did not compensate for the user-visible
latency failure.

Production topology cell D is an honest `FAIL`: 417,600 were offered, 410,372
were accepted, 7,228 ended caller-unknown, only 35.123084% received a receipt
within 1 second, and receipt p99 was 13,007.533 ms. Accepted-work reconciliation
still passed with 410,372 Good Root Outcomes and 615,590 / 615,590 AgentRuns
succeeded. Correctness does not erase the admission and receipt failure. The
stable A/B/C/D matrix summary is now copied into this packet. All four cells
failed admission while reconciling accepted work exactly. The comparison
supports retained history as a degradation cause. A larger WAL envelope cut
WAL and checkpoint churn, but did not qualify admission. Both sealed provider
roots ended with zero manifest-owned cloud residue and empty resource
inventories.

Full `us-east4` production qualification remains `MISSING`. Continue with an
open-arrival overload sweep. Freeze identity sets, workload seeds, topology,
raw samples, resource captures, and checksums. Find the first rate where
goodput, receipts, First Meaningful ThreadEvent latency, correctness, backlog,
or bounded resources fail. Do not call the last offered rate a ceiling unless
every lower gate passed.

Full outage recovery is also `MISSING`. The declared 15-minute outage at 348
AgentRuns/s accumulates 313,200 runs. The final matrix used the 400,000-AgentRun
reserve candidate, so sizing is no longer the missing input. The matrix tested
admission, not the declared outage or recovery. After admission stability is
repaired, keep 232 commands/s running during outage and recovery, cut the
selected worker fleet, require visible recovery progress within 5 minutes,
full drain within 20 minutes, and reconcile every run, attempt, fence, budget,
and ThreadEvent.

Current saturation evidence is incomplete. One selected production lane must
capture CPU, memory, open connections, Pub/Sub backlog and oldest age,
PostgreSQL backends and waits, table and index growth, WAL, checkpoint behavior,
relay window use, worker streams, execution slots, and per-tier limits on one
locked timeline.

The authenticated three-tab recording is `MISSING`. Record real Chrome tabs A,
B, and C using one Principal and Thread but separate session state, cursors, and
local projections. Disconnect A during live output, advance B and C, reopen A,
show replay beginning strictly after A's last applied cursor, then reconcile all
three projections with PostgreSQL. Repeat with session expiry and authorization
revocation. Store the recording in the indexed placeholder and update its
checksum before changing the gate.

The bounded Mailpit retry control passed, but a production external-action
guarantee is `MISSING`. Test an exact committed Action, stable idempotency key,
attempt recorded before contact, lost acknowledgement after provider apply,
duplicate delivery, and final ActionReceipt. Require one external effect and
never blindly retry an unknown outcome.

Dedicated screenshots or recordings for each selected load lane are also
`MISSING`. Capture them only from the sealed run and fixed time range. A Grafana
summary view does not substitute for the run-specific artifact.

## Part 3: OpenPoke architecture and next improvements

The supplied scenario says current OpenPoke works for one user, one machine,
and one process. Without asserting uninspected repository details, the first
general failure is process-local authority: in-memory conversation order,
response buffers, device connections, and worker ownership disappear together
on restart and cannot support independent resume across instances.

Improve it in this order:

1. Define Principal, Thread, UserMessage, immutable ThreadEvent, ThreadPosition,
   ThreadCursor, AgentRun, and Acceptance Receipt as separate durable concepts.
2. Put account-scoped authentication and authorization in front of every
   command, snapshot, history page, and stream.
3. Commit input, receipt, root work, capacity, and outbox atomically in
   PostgreSQL before acknowledging the client.
4. Split Native Thread Transport, relay, and workers into independently
   deployable roles. Keep the transport and worker roles stateless enough to
   replace or scale horizontally.
5. Use a bounded durable broker buffer with point-addressed database claims,
   finite leases, monotonic epochs, and harmless redelivery.
6. Persist output before delivery. Resume by opaque cursor, replay canonical
   order, then cross once into live SSE for every independently connected
   device.
7. Make effectful tools explicit Actions with stable idempotency, approval,
   attempt, uncertainty, and receipt semantics.
8. Bound queue depth, per-Principal work, database connections, stream counts,
   and execution slots. Shed overload before unbounded waiting destroys useful
   work.
9. Qualify the Production Acceptance Corpus, growth corpora, overload knee,
   process and dependency loss, recovery reserve, multi-device load, and total
   cost before declaring production readiness.
10. Add multi-region recovery only after the single-region authority and
    failover contracts are explicit. Do not introduce two writable Thread
    orders accidentally.
