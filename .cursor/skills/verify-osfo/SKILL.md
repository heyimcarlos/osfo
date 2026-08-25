---
name: verify-osfo
description: Verify Osfo's public Worker registration and billing journeys with isolated PostgreSQL, or qualify live Supermemory correction behavior before reporting an Osfo feature as working.
---

# Verify Osfo

Osfo's implemented product behavior lives in the Cloudflare Worker. The web app is a secondary preview and does not yet connect chat transport or all product behavior. Use the composed Worker journeys for registration and billing. Use the credentialed live harness only for the narrower Supermemory behavior it names.

Read [the feature map](features/README.md) before choosing a drive. Do not report a browser or messaging entry point as verified when only its Worker or provider adapter was exercised.

## Launch

Install the pinned dependencies once from the repository root:

```sh
bun install --frozen-lockfile
```

Create a unique run and start its isolated PostgreSQL container:

```sh
RUN_ID="registration-$(date -u +%Y%m%dT%H%M%SZ)-$$"
./.cursor/skills/verify-osfo/helpers/control-osfo start "$RUN_ID"
```

`start` is ready when it prints `ready run=<run-id>` with the container ID and mapped PostgreSQL port. The Cloudflare Vitest plugin starts a fresh workerd instance, local Twilio and Stripe emulators, and a read-only database observer inside each drive. It tears those processes down when the drive exits.

Two runs can coexist because each run has its own container, mapped port, database-name prefix, workerd storage, and artifact directory. Never reuse another run's ID.

The live Supermemory drive is short-lived and needs no local server. It reads `SUPERMEMORY_API_KEY` from `apps/worker/.env` and talks to the configured production provider boundary.

## Doctor

Run the read-only doctor before every composed Worker drive:

```sh
./.cursor/skills/verify-osfo/helpers/control-osfo doctor "$RUN_ID"
```

It requires the repository's pinned Bun and Node versions, the installed Vitest binary, the exact labeled container created by this run, and a successful `pg_isready` from that container. Refuse to drive if doctor fails.

For live Supermemory, verify only that the local credential is present without printing it:

```sh
./.cursor/skills/verify-osfo/helpers/control-osfo doctor-live
```

Credential presence is not proof that the provider is healthy. The live drive must authenticate and complete before reporting success.

## Drive

Use the feature recipe, then invoke its exact drive:

```sh
./.cursor/skills/verify-osfo/helpers/control-osfo drive "$RUN_ID" registration
./.cursor/skills/verify-osfo/helpers/control-osfo drive "$RUN_ID" billing-checkout
```

Each composed drive sends requests through the public Worker route tree. It does not insert a User directly or call a test-only authentication endpoint. Twilio and Stripe are mocked only at their existing production HTTP adapter boundaries. The database observer reads committed state and cannot set it.

Run live memory correction separately:

```sh
LIVE_RUN_ID="memory-$(date -u +%Y%m%dT%H%M%SZ)-$$"
./.cursor/skills/verify-osfo/helpers/control-osfo drive-live "$LIVE_RUN_ID" memory-correction
```

The live drive uses the real Supermemory adapter and provider. It does not prove that a browser or messaging client can reach the same behavior.

## Evidence

Every drive writes evidence under `artifacts/verification/osfo/<run-id>/`:

- `metadata.txt` records the run ID, feature, UTC start time, commit, and exact command.
- `journey-source.ts` preserves the assertions that defined the action and expected state for that commit.
- `transcript.log` captures the action's runner output and final result.
- `result.txt` records the exit code and completion time.

A passing composed journey proves the real public HTTP path and its committed database and provider-adapter side effects together. Registration evidence covers OTP send, OTP verification, session establishment, registration, the Free Plan, the Osfo Agent, and the Twilio ledger. Billing evidence covers registration, Checkout creation, stored billing state, Stripe metadata, and idempotency keys.

A green final screen or status alone is insufficient. Keep `journey-source.ts` beside the transcript so reviewers can see which side effects the passing run observed. Never replace the public route with an internal setter or direct fixture row. Do not use production SMS or Stripe for the composed drives.

The live memory transcript must contain the positive correction, confirmation, and association stages plus the negative assistant-only, hypothetical, and fictional matrix. A provider `done` status alone is not proof of searchability.

## Cleanup

Remove only the PostgreSQL container and scratch state created by this run:

```sh
./.cursor/skills/verify-osfo/helpers/control-osfo cleanup "$RUN_ID"
```

The helper resolves the recorded container ID and verifies its run label before removal. It never kills by process name. PostgreSQL scratch data is deleted with the container and cannot be recovered. Evidence under `artifacts/verification/osfo/<run-id>/` survives cleanup.

After cleanup, confirm the proof remains:

```sh
test -s "artifacts/verification/osfo/$RUN_ID/transcript.log"
test -s "artifacts/verification/osfo/$RUN_ID/result.txt"
```

The live Supermemory test registers a finalizer that deletes its synthetic user knowledge. Failed or interrupted live runs need a provider audit before rerunning because process termination can prevent the finalizer.

## Helpers

`helpers/control-osfo` is the executable entry point for launch, doctor, drive, evidence capture, and cleanup:

```sh
./.cursor/skills/verify-osfo/helpers/control-osfo help
```

Run it from any directory inside the checkout. It resolves the repository root from its own path.
