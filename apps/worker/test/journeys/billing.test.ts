import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

/* oxlint-disable effecttsgo/global-fetch-in-effect, effecttsgo/prefer-schema-over-json -- The composed journey intentionally drives raw hosted-browser and Worker HTTP boundaries. */

import { spawnApp } from "../support/spawn-app";

it.effect("activates Adventurer through hosted Checkout return reconciliation", () =>
  Effect.gen(function* () {
    const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
      Effect.promise(client.dispose),
    );
    const identity = yield* Effect.promise(() =>
      app.auth.mintVerifiedUser({
        profile: {
          helpAreas: ["money-planning"],
          locale: "en",
          preferredName: "Grace",
        },
      }),
    );

    const checkout = yield* Effect.promise(app.billing.checkout);
    expect(checkout.response.status).toBe(200);
    expect(checkout.body).toEqual({
      url: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:\d+\/_local\/stripe\/checkout\/cs_test_emulated$/u,
      ),
    });

    const stored = yield* Effect.promise(() => app.database.billingCheckout(identity.userId));
    expect(stored).toMatchObject({
      billing_checkout_session_id: expect.any(String),
      billing_customer_id: expect.any(String),
      state: "open",
      stripe_checkout_session_id: "cs_test_emulated",
      stripe_customer_id: "cus_emulated",
      stripe_price_id: "price_adventurer",
      stripe_product_id: "prod_adventurer",
      target_plan: "adventurer",
    });

    const stripe = yield* Effect.promise(app.stripe.ledger);
    expect(stripe.map((entry) => entry.path)).toEqual(["/v1/customers", "/v1/checkout/sessions"]);
    expect(stripe[0]).toMatchObject({
      idempotencyKey: expect.any(String),
      parameters: {
        "metadata[billingCustomerId]": expect.any(String),
        "metadata[userId]": identity.userId,
      },
    });
    expect(stripe[1]).toMatchObject({
      idempotencyKey: expect.any(String),
      parameters: {
        customer: "cus_emulated",
        "line_items[0][price]": "price_adventurer",
        "metadata[productId]": "prod_adventurer",
        "metadata[userId]": identity.userId,
        mode: "subscription",
      },
    });
    if (checkout.body === undefined) throw new Error("Checkout did not return its hosted URL");
    const checkoutUrl = checkout.body.url;

    const hosted = yield* Effect.promise(() => fetch(checkoutUrl));
    expect(hosted.status).toBe(200);
    expect(yield* Effect.promise(() => hosted.text())).toContain("Complete verification checkout");

    const completed = yield* Effect.promise(() =>
      fetch(checkoutUrl, { method: "POST", redirect: "manual" }),
    );
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toContain(
      "/settings/billing?source=checkout&session_id=cs_test_emulated",
    );

    const reconciliation = yield* Effect.promise(() =>
      app.fetch("/v1/billing/reconcile", {
        body: JSON.stringify({
          reason: "checkoutReturn",
          stripeCheckoutSessionId: "cs_test_emulated",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(reconciliation.status).toBe(200);
    expect(yield* Effect.promise(() => reconciliation.json())).toEqual({ result: "activated" });
    expect(yield* Effect.promise(() => app.database.registration(identity.userId))).toMatchObject({
      allowance_plan: "adventurer",
      billing_plan: "adventurer",
    });
  }),
);
