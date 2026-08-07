# OpenPoke v1 demo packet

This is the durable presentation and evidence entry point for issue #99.
Current overall qualification is `MISSING`, not `PASS`.

- [Current architecture](architecture.md)
- [Exact evidence matrix](evidence.md)
- [Development runtime demo disposition](development-runtime.md)
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

Thirteen deterministic PNG cards provide run-specific visual summaries. Every
card says `post-run render from sealed records, not an in-run screen capture`
and derives its run ID, timestamps, workload, verdict, and source-manifest hash
from packet-owned verified records. The authenticated three-tab MP4 is a local
PostgreSQL Chrome journey at 4 frames per second. It proves independent
observer-tab disconnect and cursor resume, not sender closure mid-response,
session expiry, production load, or production qualification.

Run the packet verifier from the repository root:

```bash
bun run demo:evidence:verify
```

The deterministic cards can be reproduced only after that verifier passes.
The renderer reads each sealed input through canonical, no-follow file handles,
checks its indexed digest again, renders the complete set in temporary staging,
and requires every PNG and the new manifest to match the indexed packet. It
never overwrites the sealed packet:

```bash
bun run demo:evidence:cards
```

The live local journey is opt-in and writes to a new candidate directory. It
never overwrites indexed bytes:

```bash
OSFO_THREE_TAB_OUTPUT_DIR=<new-empty-output-directory> \
  bun run --env-file=.env demo:evidence:three-tab
```

Full `us-east4` production qualification, selected-topology saturation, full
outage drain, production ActionReceipt proof, and complete production cost
remain `MISSING`. The four artifact-index placeholders remain explicit and no
local or historical evidence is promoted to those production scopes.
