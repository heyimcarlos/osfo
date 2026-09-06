---
name: verify-osfo
description: Verify Osfo registration, SMS phone authentication, Telegram or WhatsApp channel linking, ordinary conversation and Core Memory across Sessions, chat attachments and PDF forms, Research Reports, Document Build, immediate Gmail send, Scheduled Email, Reminder Approval and due delivery, billing, permanent account deletion, or retained deletion replay in Chrome with a disposable verified User, local provider boundaries, committed state, and durable evidence. Use after implementing or reviewing one of those browser paths.
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

The helper derives each run's Wrangler config from `apps/worker/wrangler.jsonc`. It changes only the run name, local provider and browser origins, test credentials, run-owned PostgreSQL connection, R2 bucket names, and Workflow name. It removes the inactive `ai` and `websearch` remote-provider bindings so a local journey cannot open a Cloudflare proxy session. Compatibility settings, all other bindings, migrations, containers, triggers, and observability remain canonical.

The run is ready when all of these hold:

- the printed web URL serves `/get-started`;
- the printed Worker URL serves `/auth/get-session`;
- PostgreSQL answers `pg_isready` inside the run-labeled container;
- `doctor` reports the same launch commit as the current checkout.

Multiple runs may keep their isolated processes and storage running, but authenticate only one run per Chrome profile. Different `127.0.0.1` ports share cookies; tabs and named automation sessions do not isolate them. Use separate Chrome profiles for concurrent authenticated runs. Use the same authenticated dashboard tab for registration and channel linking. Preserve a tab when the selected feature explicitly marks it mounted. A feature may direct temporary provider or billing tabs; close or leave those tabs when directed.

## Doctor

Run the read-only doctor before browser work and whenever a page or request looks wrong:

```sh
./.agents/skills/verify-osfo/helpers/control-osfo doctor "$RUN_ID"
./.agents/skills/verify-osfo/helpers/control-osfo identity "$RUN_ID"
```

Doctor rejects a changed commit, reused PID, missing run label, unhealthy local provider, stopped Worker, or stopped UI. Read `artifacts/verification/osfo/<run-id>/logs/` before restarting. Cleanup the failed run, choose a new run ID, and start again.

`identity` prints the run-owned preferred name, valid fictional Canadian phone number, OTP, and web origin. The local Twilio adapter accepts `424242`; production Twilio does not.

The WhatsApp Reminder drive uses `whatsapp-invite` to deliver one signed run-owned provider
message and extract its real browser invitation, then `whatsapp-reply` for the authorized reply
after the fixed-template assertion. These commands exercise the production webhook adapter; they
do not insert Channel Links, Reminders, occurrences, or Wake-up rows.

## Drive in Chrome

Use Chrome browser control, not `curl`, Playwright from the shell, a Better Auth test helper, or a database write. Continue in the run's Chrome session and follow the selected feature's tab sequence.

Open the selected feature file for its only authoritative drive and completion criterion:

- [registration](features/registration.md)
- [channel linking](features/channel-linking.md)
- [conversation and Core Memory](features/conversation-memory.md)
- [Research Report](features/research-report.md)
- [Document Build](features/document-build.md)
- [chat attachments and interactive PDF forms](features/chat-pdf-form.md), preparation and byte checks remain draft pending the integrated drive
- [Immediate Gmail send](features/immediate-gmail-send.md)
- [Scheduled Email](features/scheduled-email.md)
- [Free billing summary](features/billing.md)
- [account deletion](features/account-deletion.md)
- [account deletion replay](features/account-deletion-replay.md)
- [WhatsApp Wake-up](features/whatsapp-wakeup.md)

For any mapped feature, start evidence before its first action. Save `action.png` when the named action is ready and `result.png` only after the named result appears. Record both visible facts, observe committed state, and finish:

```sh
FEATURE=registration # registration, channel-linking, conversation-memory, research-report, document-build-free-denial, document-build, immediate-gmail-send, scheduled-email, billing, whatsapp-wakeup, account-deletion, or account-deletion-replay
./.agents/skills/verify-osfo/helpers/control-osfo evidence "$RUN_ID" "$FEATURE" start
# Save Chrome screenshots to the exact action.png and result.png paths printed above.
./.agents/skills/verify-osfo/helpers/control-osfo record "$RUN_ID" "$FEATURE" action \
  "visible fact immediately before the User action"
./.agents/skills/verify-osfo/helpers/control-osfo record "$RUN_ID" "$FEATURE" result \
  "visible fact after the User action completed"
./.agents/skills/verify-osfo/helpers/control-osfo observe "$RUN_ID" "$FEATURE"
./.agents/skills/verify-osfo/helpers/control-osfo evidence "$RUN_ID" "$FEATURE" finish
```

Immediate Gmail defers only `evidence finish` until retained account-deletion replay supplies
its deletion receipt. Complete its browser Approval, result recording, and `observe` before
starting Scheduled Email evidence, which resets the shared provider ledger. Its
[feature file](features/immediate-gmail-send.md) gives the exact sequence.

## Evidence

Complete browser evidence lives under `artifacts/verification/osfo/<run-id>/<feature>/`:

- `metadata.txt` identifies the unique run, feature, exact launch commit, origins, command, and UTC start;
- `browser-actions.txt` records what the action and result screenshots visibly prove;
- `action.png` and `result.png` capture both halves of the User journey;
- `state.json` is a read-only observation of committed product state;
- `provider.json` captures the local production-boundary ledger;
- Immediate Gmail also records `approval.json`, `browser-evidence.json`, a same-commit
  replay qualification, and the later account-deletion receipt;
- `observation-passed.txt` exists only after the state and provider assertions pass;
- `result.txt` records the feature outcome, exact commit, and completion time.

Each feature file owns its visible result and durable PASS criterion. Do not substitute one feature's proof for another.

If HEAD changes after launch, discard the run as stale and repeat. A screenshot from one commit plus database state from another is not evidence.

`start` records whether the checkout was clean. A run launched dirty remains a draft even if the checkout is later restored. `evidence finish` records PASS only when the run launched clean, HEAD is unchanged, the checkout is still clean, and the observer wrote its post-assertion marker. Commit the implementation, start a fresh run, and repeat the proof before handoff.

Run IDs are single-use evidence identities. `start` fails if either active scratch
state or a preserved artifact directory already exists. Cleanup removes only scratch
state and keeps evidence, so always choose a fresh run ID instead of appending to an
earlier run's logs.

The composed Worker journeys remain useful isolation tests. The standard command derives the run-owned Worker, PostgreSQL, and disposable phone details from run state. It first proves that the live account-deletion endpoint rejects one edited retained envelope without consuming it, accepts the untouched request, and reaches terminal scheduled deletion; then it runs the remaining Worker journeys:

```sh
./.agents/skills/verify-osfo/helpers/control-osfo journeys "$RUN_ID"
```

Report them as Worker qualification. They do not replace the Chrome evidence above.

To repeat only the live edited-envelope proof, use the standard subcommand. It creates a fresh User for the run-owned phone and terminally removes the User, Action, Deletion Case, fence, and sessions before returning, including through its failure finalizer:

```sh
./.agents/skills/verify-osfo/helpers/control-osfo account-deletion-envelope-journey "$RUN_ID"
```

## Cleanup

Cleanup verifies every member of each recorded run-owned process group, stops the complete groups, verifies the PostgreSQL run label, removes that container, and deletes run scratch state. Evidence survives:

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
