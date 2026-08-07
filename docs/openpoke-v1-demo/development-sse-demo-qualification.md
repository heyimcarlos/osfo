# Development SSE demo qualification

Issue #100 has a bounded development-only qualification lane. It is intentionally
smaller than production qualification: one seeded account, two to four concurrent
authenticated SSE clients, a sender disconnect before its AgentRun terminates,
resume from the last observed signed cursor, a modest command burst, exact
canonical-history comparison, and backlog drain timing.
The measured drain is specifically the interval from the final command offer to
all accepted commands reaching terminal canonical events. Broker backlog drain
and full return to steady state remain `MISSING` unless separately measured.

The lane runs only after the issue #90 development runtime is live. The bearer,
thread identifier, and optional approved private database URL remain ignored
operator inputs. They are never accepted as command-line arguments. The bearer
and database URL are neither copied into the bundle nor printed; the non-secret
thread identifier is recorded in the manifest. The bundle contains receipt identifiers, canonical event
envelopes, sanitized reconciliation output, topology, monitoring responses, and
SHA-256 checksums.

```bash
GCP_DEVELOPMENT_PROJECT_ID=osfo-development-318708913 \
OSFO_RUNTIME_ORIGIN=https://reviewed-development-origin.example \
OSFO_REFERENCE_AUTHENTICATION_TOKEN="$REFERENCE_TOKEN" \
OSFO_REFERENCE_THREAD_ID="$REFERENCE_THREAD_ID" \
OSFO_DATABASE_URL='postgresql://<approved-role>@127.0.0.1:5432/osfo' \
  infra/tests/development-sse-demo-qualification.sh
```

Defaults are four devices, six load commands, a 500 ms offer interval, and a
180-second drain deadline. Keep the demo bounded:

```bash
OSFO_SSE_DEVICE_COUNT=3 \
OSFO_SSE_COMMAND_COUNT=4 \
OSFO_SSE_COMMAND_INTERVAL_MS=750 \
  infra/tests/development-sse-demo-qualification.sh
```

Set `OSFO_SSE_CAPTURE_HOOK` to an executable that accepts a phase and an output
directory. It is called at `before_load`, `after_disconnect`, `after_load`, and
`after_drain`. The hook can take browser screenshots or start and stop a recording;
everything it writes below the supplied directory is checksum-sealed. The harness
removes the bearer, database URLs, and provider credentials from the hook's
environment before invoking it.

Evidence is written below `tmp/issue-100-sse-qualification/<run>/` by default.
Every execution seals partial evidence, including failed runs. `manifest.json`
records the exact source, target, workload, and development verdict;
`verdicts.json` records every gate as `PASS`, `FAIL`, or `MISSING`; `summary.json`
contains the measured low-load results; `raw/` retains HTTP and SSE output;
`reconciliation/`, `topology/`, `monitoring/`, and `captures/` retain optional
supporting evidence; `SHA256SUMS` seals the complete bundle.

This lane cannot close issue #100. It always reports the healthy concurrent-stream
ceiling, breaking point, several-account matrix, deployed fault cuts, production
topology, and production qualification as `MISSING`. Local lifecycle tests remain
useful supporting evidence, but they do not replace deployed failure injection.

## Evidence cockpit snapshot

[`evidence/catalog/development-sse-attempts.json`](evidence/catalog/development-sse-attempts.json)
preserves all three bounded development attempts in order: an initial partial
`PASS`, a `FAIL` caused by device convergence, and the final bounded `PASS`.
The final attempt proves its recorded four-device and canonical reconciliation
scope, but resource measurement windows and a capture recording remain
`MISSING`. Healthy ceiling, breaking point, several-account load, deployed
fault cuts, broker return to steady state, production topology, and production
qualification also remain `MISSING`.

The snapshot contains sanitized normalized facts and the original bundle seal
digests. It excludes bearer values, database URLs, provider payloads, model
content, raw request identities, and private paths. The packet catalog snapshot
manifest seals the copied snapshot bytes. It does not promote the development
lane into production evidence.
