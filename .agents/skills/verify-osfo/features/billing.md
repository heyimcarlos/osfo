# Inspect Free billing

The billing page shows the registered User's current Free Plan, allowance period, and the entry point to hosted Adventurer Checkout.

## Sub-features

- authenticated billing summary;
- visible Free Plan and reset period;
- Checkout creation through the local Stripe HTTP boundary;
- stored open Checkout attempt.

## How to get to it (user POV)

After registration, open `/settings/billing`. The page shows `Current Plan`, `Free Plan`, and the controls that continue to Stripe-hosted billing.

## Driving it with Chrome

Use the registered run's tab and open `/settings/billing`. Wait for `Free Plan`. Capture that visible state if the changed behavior concerns plan presentation. The existing composed Worker billing journey may qualify Checkout creation and its committed attempt through the Stripe emulator.

## Gotchas

- The harness does not implement a fake hosted Stripe website. Navigation after `Upgrade` or `Continue to secure checkout` leaves the local Osfo UI.
- Visible `Free Plan` plus committed Free subscription and allowance state can pass a billing-summary change. It does not prove hosted Checkout completion.
- The composed billing journey is a draft for User verification unless Chrome also exercises the changed browser behavior.
- Report the Stripe-owned hosted page as the exact external prerequisite when it is in scope.
