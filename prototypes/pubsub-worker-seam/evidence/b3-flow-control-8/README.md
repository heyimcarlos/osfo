# Curated B3 flow-control evidence

This compact bundle retains the decision evidence for the worker concurrency
eight qualification study. The complete generated directory was 5.8 MB and is
recoverable from system trash until it is emptied. The retained bundle is under
200 KB and contains:

- authoritative audits, scenarios, and load-client summaries for the warm-up,
  contaminated cold target, and admissible warm target;
- the qualified worker, ingress, relay, subscription, and Cloud SQL topology;
- selected worker, relay, Cloud SQL, backlog, acknowledgement, and push-response
  metrics;
- derived runtime-error and resource summaries;
- teardown inventory and zero-residue verification;
- a fresh `SHA256SUMS` manifest.

The lane named `warm-target-smoke-232-1` recreated its subscription because the
reuse flag was initially applied to the wrong harness call site. Its scenario
field says the subscription was not reset, but that field is contradicted by
the controller output and is not admissible decision evidence. The corrected
`warm-target-qualified-232-1` lane ran from source commit `0436a94` and did not
recreate the drained subscription.
