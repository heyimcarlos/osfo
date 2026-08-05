# Curated B3 stripe-study evidence

This directory retains the decision-critical raw evidence for the 16- and
64-stripe transactional-outbox experiments without restoring the large runtime
logs and per-request sample bundles that destabilized local source-control
tooling.

Each stripe directory contains:

- authoritative lane audits and exact scenario windows;
- load-client completion summaries;
- Cloud SQL CPU and backend-count metrics;
- Pub/Sub push response classes, backlog count, and oldest backlog age;
- ingress, relay, and worker instance counts;
- Cloud Run and Pub/Sub topology captures plus the source commit;
- exact-prefix teardown verification; and
- a `SHA256SUMS` file covering the curated set.

The original files passed their lane-level checksums before curation. The
curated 16- and 64-stripe sets were recovered from system trash on August 4,
2026 and checksummed again.

Earlier raw evidence remains recoverable from Git history:

- B2 negative control: commit `bf53d85`
- corrected four-stripe B3 candidate: commit `d0a41cb`

Discarded files were high-volume runtime logs, per-request caller samples, and
redundant monitoring series. They were not used to calculate the counts or
percentiles recorded in `B3-STRIPE-RESULTS.md`.
