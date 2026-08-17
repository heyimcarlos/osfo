import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { BillingScreen } from "./billing-screen";

/* oxlint-disable effecttsgo/global-date -- These static presentation tests use fixed Date fixtures. */

describe("BillingScreen", () => {
  it("shows current Plan, scheduled cancellation, period, and safe actions", () => {
    const html = renderToStaticMarkup(
      <BillingScreen
        onCheckout={() => undefined}
        onPortal={() => undefined}
        summary={{
          currentPlan: "adventurer",
          paymentState: "changeScheduled",
          pendingPlan: {
            effectiveAt: new Date("2026-09-16T00:00:00.000Z"),
            plan: "free",
          },
          period: {
            endsAt: new Date("2026-09-16T00:00:00.000Z"),
            startsAt: new Date("2026-08-16T00:00:00.000Z"),
          },
        }}
      />,
    );

    expect(html).toContain("Adventurer");
    expect(html).toContain("Free starts");
    expect(html).toContain("September 16, 2026");
    expect(html).toContain("Manage billing");
    expect(html).not.toContain("customer.subscription");
    expect(html).not.toContain("past_due");
  });

  it("offers Stripe-hosted Checkout on Free without technical payment details", () => {
    const html = renderToStaticMarkup(
      <BillingScreen
        onCheckout={() => undefined}
        onPortal={() => undefined}
        summary={{
          currentPlan: "free",
          paymentState: "free",
          pendingPlan: null,
          period: {
            endsAt: new Date("2026-09-15T00:00:00.000Z"),
            startsAt: new Date("2026-08-16T00:00:00.000Z"),
          },
        }}
      />,
    );

    expect(html).toContain("Continue to secure checkout");
    expect(html).toContain("CA$25 each month, plus tax");
    expect(html).not.toContain("price_");
    expect(html).not.toContain("retry");
  });

  it("uses safe payment-attention language after a failed Checkout", () => {
    const html = renderToStaticMarkup(
      <BillingScreen
        onCheckout={() => undefined}
        onPortal={() => undefined}
        summary={{
          currentPlan: "free",
          paymentState: "paymentNeeded",
          pendingPlan: null,
          period: null,
        }}
      />,
    );

    expect(html).toContain("Payment needs attention before paid access can start");
    expect(html).not.toContain("payment_intent");
  });
});
