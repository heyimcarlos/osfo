---
name: verify-osfo
description: Verify user-visible Osfo web behavior in Chrome with a disposable SMS-verified User, local Worker/provider boundaries, committed PostgreSQL state, and durable evidence. Use after implementing or reviewing registration, authentication, channel linking, settings, billing, privacy, or another browser-facing Osfo change.
---

# Verify Osfo

Use this skill for user verification. A Worker request or passing Vitest journey is supporting qualification, not proof that a User can complete the feature.

Read the [feature map](features/README.md), choose the smallest mapped drive that covers the changed behavior, and run it through Chrome. The helper owns local processes and test data. Chrome owns every User action.

## Launch

From the repository root, install the pinned dependencies once, create a unique lowercase run ID, and start the isolated app:

```sh
bun install --frozen-lockfile
RUN_ID="verify-$(date -u +%Y%m%d-%H%M%S)-$$"
./.agents/skills/verify-osfo/helpers/control-osfo start "$RUN_ID"
```

`start` launches one labeled PostgreSQL container, applies the real migrations, starts local Twilio, Telegram, Stripe, and Supermemory HTTP emulators, starts the actual Worker under Wrangler with run-owned Durable Object and R2 storage, and starts the Vite web UI. It prints `ready` only after `/auth/get-session` and `/get-started` answer.

The run is ready when all of these hold:

- the printed web URL serves `/get-started`;
- the printed Worker URL serves `/auth/get-session`;
- PostgreSQL answers `pg_isready` inside the run-labeled container;
- `doctor` reports the same launch commit as the current checkout.

Two runs may coexist because their ports, container, Worker storage, User identity, Telegram address, and evidence directory differ. Use one Chrome tab per run. Never drive another run's URL.

## Doctor

Run the read-only doctor before browser work and whenever a page or request looks wrong:

```sh
./.agents/skills/verify-osfo/helpers/control-osfo doctor "$RUN_ID"
./.agents/skills/verify-osfo/helpers/control-osfo identity "$RUN_ID"
```

Doctor rejects a changed commit, reused PID, missing run label, unhealthy local provider, stopped Worker, or stopped UI. Read `artifacts/verification/osfo/<run-id>/logs/` before restarting. Cleanup the failed run, choose a new run ID, and start again.

`identity` prints the run-owned preferred name, valid fictional Canadian phone number, OTP, and web origin. The local Twilio adapter accepts `424242`; production Twilio does not.

## Drive in Chrome

Use Chrome browser control, not `curl`, Playwright from the shell, a Better Auth test helper, or a database write. Keep the same Chrome tab for registration and channel linking so the verified session remains present.

Open the selected feature file for its only authoritative drive and completion criterion:

- [registration](features/registration.md)
- [channel linking](features/channel-linking.md)
- [Free billing summary](features/billing.md)

For any mapped feature, start evidence before its first action. Save `action.png` when the named action is ready and `result.png` only after the named result appears. Record both visible facts, observe committed state, and finish:

```sh
FEATURE=registration # registration, channel-linking, or billing
./.agents/skills/verify-osfo/helpers/control-osfo evidence "$RUN_ID" "$FEATURE" start
# Save Chrome screenshots to the exact action.png and result.png paths printed above.
./.agents/skills/verify-osfo/helpers/control-osfo record "$RUN_ID" "$FEATURE" action \
  "visible fact immediately before the User action"
./.agents/skills/verify-osfo/helpers/control-osfo record "$RUN_ID" "$FEATURE" result \
  "visible fact after the User action completed"
./.agents/skills/verify-osfo/helpers/control-osfo observe "$RUN_ID" "$FEATURE"
./.agents/skills/verify-osfo/helpers/control-osfo evidence "$RUN_ID" "$FEATURE" finish
```

## Evidence

Complete browser evidence lives under `artifacts/verification/osfo/<run-id>/<feature>/`:

- `metadata.txt` identifies the unique run, feature, exact launch commit, origins, command, and UTC start;
- `browser-actions.txt` records what the action and result screenshots visibly prove;
- `action.png` and `result.png` capture both halves of the User journey;
- `state.json` is a read-only observation of committed product state;
- `provider.json` captures the local production-boundary ledger;
- `result.txt` records PASS, the exact commit, and completion time.

Each feature file owns its visible result and durable PASS criterion. Do not substitute one feature's proof for another.

If HEAD changes after launch, discard the run as stale and repeat. A screenshot from one commit plus database state from another is not evidence.

Iterative browser runs may use a dirty checkout, but `evidence finish` records PASS only for a clean checkout launched at its current commit. Commit the implementation, start a fresh run, and repeat the proof before handoff.

The composed Worker journeys remain useful isolation tests. Run them against the run-owned PostgreSQL maintenance database without copying its dynamic port:

```sh
./.agents/skills/verify-osfo/helpers/control-osfo journeys "$RUN_ID"
```

Report them as Worker qualification. They do not replace the Chrome evidence above.

## Cleanup

Cleanup stops only the recorded run-owned process groups, verifies the PostgreSQL run label, removes that container, and deletes run scratch state. Evidence survives:

```sh
./.agents/skills/verify-osfo/helpers/control-osfo cleanup "$RUN_ID"
test -s "artifacts/verification/osfo/$RUN_ID/registration/result.txt"
```

PostgreSQL and local Worker storage are deleted and cannot be recovered. Evidence remains under `artifacts/verification/osfo/<run-id>/`. Never kill by process name and never delete another run's state.

## Merge-ready checks

For user-visible work, run the scoped web tests, Worker tests affected by the change, the web production build, and the repository gates required by `AGENTS.md`. Record the exact commands with the browser evidence. A green build without the Chrome drive leaves verification incomplete.

## Helper

The executable entry point works from any directory inside this checkout:

```sh
./.agents/skills/verify-osfo/helpers/control-osfo help
```
