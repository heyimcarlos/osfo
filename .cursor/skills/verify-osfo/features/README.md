# Osfo verification map

This directory is the maintained source for verifying Osfo's user-facing behavior. The Cloudflare Worker is the current product behavior surface. The web application previews registration and settings, but chat transport and several product behaviors are not connected there yet.

## Baseline preconditions

- Use Bun 1.3.14 and Node v24.18.0 with `bun install --frozen-lockfile` complete.
- Create a unique run with `control-osfo start <run-id>` for composed Worker journeys.
- Require `control-osfo doctor <run-id>` to name the expected labeled PostgreSQL container, mapped port, and commit.
- Never drive an instance or database created by another run.
- Keep `apps/worker/.env` local and uncommitted. Live Supermemory qualification requires a valid `SUPERMEMORY_API_KEY` there.

## Driving conventions

- Start every composed recipe from a new run unless its preconditions say otherwise.
- Treat every route named in a recipe as the public application entry point. Database observers are read-only proof, not setup shortcuts.
- The local Twilio and Stripe emulators replace only the same HTTP boundaries used in production.
- Use synthetic `+1555` phone numbers in composed journeys. Never send production SMS for verification.
- Keep the feature's transcript, result, metadata, and copied journey assertions together.

## Proof and skip reporting

- Capture the public action and the resulting committed state in the same drive.
- A passing assertion is reviewable evidence only when the matching `journey-source.ts` remains beside the transcript.
- Record the run ID, feature ID, commit, exact command, exit code, and UTC times.
- Report the web and messaging entry points as unverified unless a separate browser or transport run exercised them.
- Report a live provider timeout as a failed or unavailable drive. Do not convert it to a pass because ingestion reached `done`.

## Feature entry contract

Each feature file describes the user's entry point, the exact control command, the observed result, and the limits of that proof. Read all entry points before reporting the feature as completely verified.

## Features

- [Register a User](./registration.md) covers SMS challenge, session creation, registration, Free Plan provisioning, and committed profile state.
- [Start Adventurer Checkout](./billing-checkout.md) covers authenticated Checkout creation, Stripe boundary calls, and committed billing state.
- [Correct remembered information](./memory-correction.md) covers live correction ordering, independent searchability, semantic association, confirmation, and negative extraction cases.
