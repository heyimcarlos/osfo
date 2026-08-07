# OpenPoke v1 demo packet

This is the durable presentation and evidence entry point for issue #99.
Current overall qualification is `MISSING`, not `PASS`.

- [Current architecture](architecture.md)
- [Exact evidence matrix](evidence.md)
- [Three-part walkthrough](walkthrough.md)
- [Fail-closed artifact index](artifact-index.json)

The selected command-plane topology is PostgreSQL authority, N1 relay, one
ordered Pub/Sub subscription, and a fixed StreamingPull worker fleet. Historical
authenticated Pub/Sub push and direct PostgreSQL dispatch results remain
context, not the current topology.

The packet copies only selected records from source bundles whose complete
`SHA256SUMS` manifests were verified before copying. Each copied byte sequence
has a new entry in the packet index. The copied source manifests preserve the
original seal and provenance, but they refer to full raw bundles that are not
vendored here. Four Grafana screenshots and the import report came from the
sealed temporary v16 capture after its complete `SEALED-SHA256SUMS` passed. The
capacity view was regenerated through the dashboard source pipeline to correct
the final matrix B/C mapping, then sealed with its generated definition and the
authoritative final matrix summary. That summary is copied from its verified
stable bundle. Its two provider roots passed their complete seals and recorded
zero manifest-owned cloud residue after teardown.

Run the packet verifier from the repository root:

```bash
bun run demo:evidence:verify
```

The required authenticated three-tab recording, per-load-run recordings, full
`us-east4` production qualification, selected-topology saturation, full outage
drain, and complete production cost remain `MISSING`. Their artifact-index
placeholders are ready for later insertion without relabeling existing evidence.
