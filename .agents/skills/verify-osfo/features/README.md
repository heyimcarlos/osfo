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
- [Inspect Free billing](billing.md) is the highest-value adjacent authenticated path. The local harness proves the visible Free Plan and committed allowance; the hosted Stripe page remains outside the local browser run.

## Proof states

- `PASS` means Chrome completed the mapped User path and the durable observer agreed.
- `FAIL` means an action or expected result was reachable and wrong.
- `verified-unreachable` means every local step up to an external provider-owned boundary ran, the exact prerequisite is named, and logs prove that boundary stopped the path.
- `draft` means only a test, request, or internal adapter ran.
