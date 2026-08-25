# Inspect Free billing

The billing page shows the registered User's current Free Plan, allowance period, and the entry point to hosted Adventurer Checkout.

## Sub-features

- authenticated billing summary;
- visible Free Plan and reset period;

## How to get to it (user POV)

After registration, open `/settings/billing`. The page shows `Current Plan`, `Free Plan`, and the controls that continue to Stripe-hosted billing.

## Driving it with Chrome

1. Complete [registration](registration.md) and keep that Chrome tab signed in.
2. Start billing evidence while `/settings` shows the `Billing` navigation link.
3. Capture the enabled `Billing` link as `action.png`, choose it, and wait for `/settings/billing`.
4. Wait for `Current Plan` and `Free Plan`, then capture `result.png`.
5. Record both screenshots, run `observe billing`, and finish the evidence.

PASS requires the visible `Free Plan` result plus the observer's run-owned Free subscription and current Free allowance period. The Stripe ledger may remain empty because this drive does not start Checkout.

## Gotchas

- The harness does not implement a fake hosted Stripe website. Navigation after `Upgrade` or `Continue to secure checkout` leaves the local Osfo UI.
- This billing-summary drive does not prove hosted Checkout completion.
- The composed billing journey is a draft for User verification unless Chrome also exercises the changed browser behavior.
- Report the Stripe-owned hosted page as the exact external prerequisite when it is in scope.
