import { describe, expect, it } from "@effect/vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { withTestRouter } from "../testing/router";
import { BillingScreen } from "./billing-screen";

/* oxlint-disable effecttsgo/global-date -- These static presentation tests use fixed Date fixtures. */

const renderBilling = (children: ReactNode) => renderToStaticMarkup(withTestRouter(children));

describe("BillingScreen", () => {
  it("shows current Plan, scheduled cancellation, period, and safe actions", () => {
    const html = renderBilling(
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
          usage: {
            label: "20%",
            remainingPercentage: 20,
            resetAt: new Date("2026-09-16T00:00:00.000Z"),
            warning: "low",
          },
        }}
      />,
    );

    expect(html).toContain("Adventurer");
    expect(html).toContain("Free starts");
    expect(html).toContain("September 16, 2026");
    expect(html).toContain("Manage billing");
    expect(html).toContain("20% Plan Usage remaining");
    expect(html).toContain("Your Plan Usage is running low");
    expect(html).not.toContain("customer.subscription");
    expect(html).not.toContain("past_due");
  });

  it("offers Stripe-hosted Checkout on Free without technical payment details", () => {
    const html = renderBilling(
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
          usage: null,
        }}
      />,
    );

    expect(html).toContain("Continue to secure checkout");
    expect(html).toContain("CA$25 each month, plus tax");
    expect(html).not.toContain("price_");
    expect(html).not.toContain("retry");
  });

  it("uses safe payment-attention language after a failed Checkout", () => {
    const html = renderBilling(
      <BillingScreen
        onCheckout={() => undefined}
        onPortal={() => undefined}
        summary={{
          currentPlan: "free",
          paymentState: "paymentNeeded",
          pendingPlan: null,
          period: null,
          usage: null,
        }}
      />,
    );

    expect(html).toContain("Payment needs attention before paid access can start");
    expect(html).not.toContain("payment_intent");
  });

  it("shows less than one percent without leaking accounting internals", () => {
    const html = renderBilling(
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
          usage: {
            label: "<1%",
            remainingPercentage: 0,
            resetAt: new Date("2026-09-15T00:00:00.000Z"),
            warning: "low",
          },
        }}
      />,
    );

    expect(html).toContain("&lt;1% Plan Usage remaining");
    expect(html).not.toContain("micros");
    expect(html).not.toContain("USD");
    expect(html).not.toContain("policy");
  });
});
