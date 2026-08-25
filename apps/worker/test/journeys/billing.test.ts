import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { spawnApp } from "../support/spawn-app";

it.effect("starts Adventurer Checkout for a newly registered User", () =>
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
    expect(checkout.body).toEqual({ url: "https://checkout.stripe.test/cs_test_emulated" });

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
  }),
);
