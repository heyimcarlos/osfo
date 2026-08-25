# Register a User

Registration proves a phone number through SMS, creates a browser session, and provisions the User's Osfo Agent and Free Plan.

## Sub-features

- preferred-name collection;
- SMS OTP send and verification through local Twilio;
- help-area selection;
- committed User, session, Agent, billing subscription, and allowance period;
- authenticated landing at the agent dashboard.

## How to get to it (user POV)

Open `/get-started`, enter a name, continue by SMS, enter the received code, choose help areas, and finish setup. Success moves the User to `/settings` and shows `Manage your agent`.

## Driving it with Chrome

1. Run `control-osfo identity <run-id>` and open its web origin plus `/get-started`.
2. Fill `Your name`, choose `Continue`, keep `Country or region` as Canada, and fill `Phone number` with `phone_national`.
3. Choose `Send code`. Capture `Enter code` and the run-owned phone as `action.png`.
4. Fill `Verification code` with the local OTP and choose `Verify and continue`.
5. Select `Research` and `Files and documents`, then choose `Finish setup`.
6. Wait for `/settings` and the `Manage your agent` heading. Capture `result.png`.
7. Record both screenshots, run `observe registration`, and finish the evidence.

## Gotchas

- A random `+1555` value fails the browser's real phone parser. Use the helper's valid fictional Canadian number.
- The OTP is fixed only at the local Twilio HTTP boundary.
- Reaching the help-area step proves authentication, not completed registration.
- A direct auth-table write, Better Auth fixture, or public-HTTP-only journey does not satisfy this drive.
- If Chrome retained a session from another run, use a fresh tab/profile before starting.
