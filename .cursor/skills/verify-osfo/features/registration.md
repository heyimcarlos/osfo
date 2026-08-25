# Register a User

Registration proves a phone number through SMS, establishes an authenticated session, and creates one User, Osfo Agent, primary route, Free Plan, and accepted setup profile.

## Sub-features

- `registration-send-otp` sends a challenge to a valid synthetic E.164 number.
- `registration-verify-otp` verifies the challenge and establishes the session cookie.
- `registration-complete` commits the profile and returns the User and Agent identities.
- `registration-provision` creates the Free billing and allowance state.
- `registration-observe` confirms the committed registration and provider ledger without setting database state.

## How to get to it (user POV)

- Choose `Get started` from the public home page, enter a preferred name, complete SMS verification, select help areas, and choose `Finish setup`.
- Open `/get-started` directly and complete the same steps.

## Driving it with control-osfo

Preconditions:

- `control-osfo start <run-id>` created the run's isolated PostgreSQL container.
- `control-osfo doctor <run-id>` reports the expected run, container, port, and commit.
- The run has no existing User.

- **Send challenge.** The journey sends `POST /auth/phone-number/send-otp` with a unique `+1555` number. HTTP success and the Twilio emulator ledger prove that the production adapter made the request.
- **Verify challenge.** The journey sends `POST /auth/phone-number/verify` with the emulator code `424242`. The response cookie is retained by the same stateful HTTP client.
- **Complete setup.** The journey sends `PUT /v1/registration` with preferred name `Ada`, locale `en`, and the `research` and `files-documents` help areas.
- **Confirm authority.** The journey requests `GET /auth/get-session`. HTTP 200 and the same verified phone number prove the session is usable.
- **Confirm committed state.** The read-only database observer returns the same Agent ID, verified-phone flag, profile choices, registration time, Free billing plan, and Free allowance plan.
- **Run and capture proof.** Execute `./.cursor/skills/verify-osfo/helpers/control-osfo drive <run-id> registration`. It must exit 0 and retain all four evidence files under `artifacts/verification/osfo/<run-id>/`.

## Gotchas

- This drive proves the public Worker routes, not the browser controls that call them.
- `424242` belongs only to the local Twilio emulator. It is not accepted by production Twilio.
- Better Auth test utilities and direct database inserts do not satisfy this feature.
- Reusing a synthetic phone number can turn creation into an existing-account flow. Start a fresh run.
- Cleanup deletes the isolated PostgreSQL container, but it retains the evidence directory.
