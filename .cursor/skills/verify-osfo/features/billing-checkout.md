# Start Adventurer Checkout

Adventurer Checkout lets a registered Free User start or recover the hosted Stripe flow for the sole paid Osfo plan without changing the subscription before Stripe confirms it.

## Sub-features

- `billing-register` creates the authenticated Free User required by billing authority.
- `billing-checkout` returns the hosted Checkout URL.
- `billing-customer` creates or reuses the Stripe customer with Osfo ownership metadata.
- `billing-pending-state` stores the open Checkout attempt without prematurely granting Adventurer.
- `billing-idempotency` supplies stable idempotency keys to both Stripe calls.

## How to get to it (user POV)

- Sign in, open `Settings`, choose `Billing`, and choose the control that starts Adventurer Checkout.
- Open `/settings/billing` while authenticated and start Checkout there.

## Driving it with control-osfo

Preconditions:

- `control-osfo start <run-id>` created the run's isolated PostgreSQL container.
- `control-osfo doctor <run-id>` reports the expected run, container, port, and commit.
- No Checkout attempt exists in the run's new database.

- **Establish billing authority.** The journey completes the public SMS and registration path for a new User whose help area is `money-planning`.
- **Start Checkout.** The journey sends `POST /v1/billing/checkout` with the authenticated session and receives `https://checkout.stripe.test/cs_test_emulated`.
- **Confirm provider calls.** The Stripe emulator ledger contains one customer request and one Checkout request. Both carry idempotency keys, and their metadata names the same User and billing customer recorded by Osfo.
- **Confirm committed state.** The read-only database observer finds an open attempt for product `prod_adventurer`, price `price_adventurer`, and session `cs_test_emulated`. The subscription is not asserted as Adventurer before reconciliation.
- **Run and capture proof.** Execute `./.cursor/skills/verify-osfo/helpers/control-osfo drive <run-id> billing-checkout`. It must exit 0 and retain all four evidence files under `artifacts/verification/osfo/<run-id>/`.

## Gotchas

- This drive proves the public Worker route and Stripe adapter, not navigation in the browser or the hosted Stripe page.
- The Stripe emulator is allowed because it replaces the configured production HTTP boundary. Internal billing setters are not allowed.
- A Checkout URL alone is insufficient. Require the stored open attempt, metadata, and idempotency evidence.
- Checkout does not grant Adventurer. Stripe webhook reconciliation owns that later transition.
- Use a fresh run when testing new creation. Recovery and reconciliation need their own mapped drives when added.
