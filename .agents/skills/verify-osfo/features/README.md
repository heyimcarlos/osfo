# Osfo browser verification map

This map covers User-visible behavior that the local Worker and web UI can drive with isolated state. Start with registration because every authenticated feature depends on that verified User session.

## Baseline

- Start a unique run and require `control-osfo doctor <run-id>` to pass at the current commit.
- Drive the public UI in Chrome with accessible roles and names.
- Use the run-owned fictional phone and local OTP from `control-osfo identity <run-id>`.
- Keep the same Chrome tab when a later feature depends on the registered session.
- Capture the visible action and result, then prove committed state with the read-only observer.
- Treat Vitest and direct Worker requests as qualification, never browser verification.

## Features

- [Register a User](registration.md) is the foundation. It proves SMS verification, session creation, registration, Agent creation, and Free Plan provisioning.
- [Link a Telegram channel](channel-linking.md) proves provider delivery, private invite presentation, browser acceptance, and the durable Channel Link.
- [Complete a Research Report](research-report.md) proves the Agent start and inspect controls, dedicated Workflow execution, deterministic local public-source and synthesis boundaries, immutable R2 evidence and artifact publication, launch accounting, and terminal follow-up.
- [Build a document](document-build.md) first proves a launch-v1 Free denial with zero accepted or costly effects, then upgrades the same User and proves Adventurer Agent start and inspect controls, dedicated main and timer Workflows, immutable source snapshots, validated publication, launch accounting, terminal follow-up, authenticated download, and deletion cleanup.
- [Send a scheduled email](scheduled-email.md) proves Chrome-owned Gmail connection, one exact Approval, durable scheduled execution, once-only local provider application, launch accounting, terminal follow-up, and Workflow-host completion.
- [Verify local billing](billing.md) proves the visible Free Plan and, when required, browser-owned Checkout initiation plus deterministic loopback completion through the production billing reconciliation service.
- [Consume a WhatsApp Reminder Wake-up](whatsapp-wakeup.md) proves exact Reminder Approvals, fixed local Utility-template delivery, one authorized reply with private Agent-owned exposure, revocation, and deletion cleanup without treating the template as result delivery.
- [Delete an account](account-deletion.md) proves exact destructive confirmation, signed-out completion, and User-scoped erasure across PostgreSQL, Agent SQLite, R2, and Supermemory while unrelated sentinels survive.
- [Resume account deletion](account-deletion-replay.md) separately proves that an exact browser-retained request can recover a lost successful response after normal session access is fenced.

## Proof states

- `PASS` means Chrome completed the mapped User path and the durable observer agreed.
- `FAIL` means an action or expected result was reachable and wrong.
- `verified-unreachable` means every local step up to an external provider-owned boundary ran, the exact prerequisite is named, and logs prove that boundary stopped the path.
- `draft` means only a test, request, or internal adapter ran.
