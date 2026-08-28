# Verify local billing

The billing page shows the registered User's current Plan and allowance period. Local development also exposes a loopback Stripe-hosted verification page whose completion returns through Osfo's production billing reconciliation path.

## Sub-features

- authenticated billing summary;
- visible Free Plan and reset period;
- browser-owned Adventurer Checkout initiation;
- deterministic loopback Stripe completion;
- authenticated Checkout-return reconciliation into an active Adventurer subscription and allowance period;

## How to get to it (user POV)

After registration, open `/settings/billing`. The page shows `Current Plan`, `Free Plan`, and the controls that continue to Stripe-hosted billing.

## Driving it with Chrome

1. Complete [registration](registration.md) and keep that Chrome tab signed in.
2. Start billing evidence while `/settings` shows the `Billing` navigation link.
3. Capture the enabled `Billing` link as `action.png`, choose it, and wait for `/settings/billing`.
4. Wait for `Current Plan` and `Free Plan`, then capture `result.png`.
5. When Adventurer authority is required by the feature under test, choose `Continue to secure checkout`, verify the loopback page says `Local Stripe verification`, and choose `Complete verification checkout`.
6. Wait for the browser to return to `/settings/billing` and show `Adventurer Plan` plus `Your paid access is active`, then capture the result.
7. Record the screenshots, run the applicable observer, and finish the evidence.

Free-summary PASS requires the visible `Free Plan` result plus the observer's run-owned Free subscription and current Free allowance period. Adventurer-completion PASS requires visible Checkout initiation, visible loopback completion, the return to Osfo, an `activated` reconciliation, and committed Adventurer subscription and allowance evidence. The Stripe ledger may remain empty only for the Free-summary drive.

## Gotchas

- The loopback Stripe page exists only inside the local provider emulator. Preview and production continue to use Stripe's hosted origin.
- The emulator retains only the Checkout facts that the installed Stripe SDK and Osfo reconciliation service read. It does not update PostgreSQL directly.
- The composed billing journey is a draft for User verification unless Chrome also exercises the changed browser behavior.
