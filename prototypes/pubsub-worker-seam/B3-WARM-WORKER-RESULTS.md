# B3 warm push-worker result

## Human decision

The human reviewer accepted manifest v2 with a desired normal
publish-to-point-claim p95 of 200 ms, a hard qualification p95 of 250 ms, and
p99 of one second. Under that UX-aligned gate, select min-zero authenticated
push. The two-instance floor is unnecessary because it added idle cost without
improving latency.

## Result under the original manifest

Reject a two-instance warm Cloud Run push-worker floor as the missing target
fix. It preserved the transactional-outbox correctness result, but it did not
meet the frozen publish-to-point-claim p95 gate. Do not run this variant's
stress lane or full manifest.

The warm floor did not reduce the selected latency. Publish-to-point-claim p95
was 140.0 ms, compared with 134.0 ms for the preceding min-zero,
concurrency-eight target, against the frozen 100 ms gate. The next subscriber
candidate should change the delivery contract, not add more push tuning.

## Controlled variant

The lane kept four commit-order sequence stripes, one active relay container,
four logical relay owners, 128-record relay batches, worker concurrency eight,
eight execution slots, a four-connection worker database pool, maximum eight
workers, and a 10-second push acknowledgement deadline. It changed only the
Cloud Run worker minimum from zero to two.

The target reused the drained and authenticated subscription created by a
230-message warm-up. The target did not recreate or seek the subscription.

## Results

| Lane | Receipt p95 | Outbox confirmation p95 | Publish-to-claim p95 | Claim-to-terminal p95 | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Fresh-subscription warm-up, 23/s for 10 seconds | 28.7 ms | 771.9 ms | 1,904.6 ms | 21.8 ms | Diagnostic only |
| Warm qualified target, 232 incoming/s | 163.5 ms | 88.2 ms | 140.0 ms | 23.0 ms | Latency fail |

The qualified target accepted all 13,920 incoming messages and terminalized
all 20,880 AgentRuns. It had zero unpublished obligations, stranded AgentRuns,
ghost delivery attempts, duplicate publications, duplicate terminal commits,
unknown caller outcomes, or nonterminal AgentRuns. Publish-to-point-claim p99
was 886.0 ms, within its one-second gate, but the binding p95 gate failed.

The offered load completed in 60.03 seconds. Platform metrics observed five
active worker instances at the end of the load, with only acknowledged HTTP
204 push responses, no expired acknowledgement series, no retained backlog
series, and no error-severity runtime entries. Captured Cloud SQL CPU peaked at
25.3 percent, with 64 benchmark database backends. These samples do not show a
worker, Pub/Sub error, or database exhaustion explanation for the tail.

## Decision implication

The two-instance floor answers its question negatively. Cold scale from zero
was not the missing cause of the remaining publish-to-point-claim p95. Raising
the push floor again would repeat a direction already bounded by Issue 39's
four-fixed-worker comparison and would add idle cost without evidence that it
solves the integrated tail.

The human decision does not keep the 100 ms gate binding. Do not run the warm
StreamingPull comparison merely to optimize an internal 34 ms difference.
Return to min-zero authenticated push and run the remaining manifest v2
qualification lanes.

The separately proposed post-commit agent-output topic remains orthogonal. Do
not add it to the dispatch qualification because that would change relay load,
database write amplification, and Pub/Sub traffic in the same experiment.
