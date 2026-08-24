import type { BillingSummary } from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { GlassPanel } from "@osfo/ui/components/glass-panel";
import { Progress } from "@osfo/ui/components/progress";
import { Check, CreditCard } from "lucide-react";

/** Safe Plan and hosted-billing actions for one authenticated User. */
export function BillingScreen({
  busy = false,
  onCheckout,
  onPortal,
  summary,
}: {
  readonly busy?: boolean;
  readonly onCheckout: () => void;
  readonly onPortal: () => void;
  readonly summary: BillingSummary;
}) {
  const currentPlan = summary.currentPlan === "adventurer" ? "Adventurer" : "Free";
  return (
    <div className="text-[#16213f]">
      <div className="mx-auto">
        <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <GlassPanel className="flex min-h-[32rem] flex-col p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-bold">Current Plan</h2>
                <p className="mt-7 text-2xl font-bold">{currentPlan} Plan</p>
              </div>
              <Button
                className="rounded-full bg-[#e8f1ff] text-[#135fdd] hover:bg-[#d9e8ff]"
                disabled={busy}
                size="sm"
                type="button"
                variant="ghost"
                onClick={summary.currentPlan === "free" ? onCheckout : onPortal}
              >
                {summary.currentPlan === "free" ? "Upgrade" : "Manage billing"}
              </Button>
            </div>
            <ul className="mt-5 grid gap-4 text-sm">
              {planFeatures(summary.currentPlan).map((feature) => (
                <li className="flex items-center gap-3" key={feature}>
                  <span className="grid size-4 place-items-center rounded-full bg-[#daf6e6] text-[#25a764]">
                    <Check aria-hidden="true" className="size-3" strokeWidth={3} />
                  </span>
                  {feature}
                </li>
              ))}
            </ul>
            <div className="mt-auto pt-8">
              <p className="text-4xl font-semibold tracking-tight">
                {summary.currentPlan === "free" ? "$0" : "CA$25"}
                <span className="ml-1 text-xs font-normal text-[#687896]">/ month</span>
              </p>
              {summary.period === null ? null : (
                <p className="mt-5 text-xs text-[#687896]">
                  Current period ends
                  <strong className="mt-1 block text-sm text-[#16213f]">
                    {formatDate(summary.period.endsAt)}
                  </strong>
                </p>
              )}
              {summary.usage === null ? null : (
                <div className="mt-7">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <strong>{summary.usage.label} Plan Usage remaining</strong>
                    <span className="text-xs text-[#687896]">
                      Resets {formatDate(summary.usage.resetAt)}
                    </span>
                  </div>
                  <Progress
                    aria-label={`${summary.usage.label} Plan Usage remaining`}
                    className="mt-3 bg-[#dbe7f6]"
                    indicatorClassName="bg-[#2f7df4]"
                    value={summary.usage.remainingPercentage}
                  />
                  {summary.usage.warning === null ? null : (
                    <p className="mt-3 text-sm font-semibold text-amber-800">
                      {summary.usage.warning === "exhausted"
                        ? `Plan Usage is exhausted. Higher-cost work resumes ${formatDate(summary.usage.resetAt)}.`
                        : `Your Plan Usage is running low. It resets ${formatDate(summary.usage.resetAt)}.`}
                    </p>
                  )}
                </div>
              )}
            </div>
          </GlassPanel>

          <div className="grid content-start gap-5">
            <GlassPanel>
              <h2 className="font-bold">Payment Method</h2>
              <div className="mt-4 flex items-center gap-3">
                <span className="grid size-11 place-items-center rounded-xl bg-[#edf4ff] text-[#2f7df4]">
                  <CreditCard aria-hidden="true" className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {summary.currentPlan === "free"
                      ? "No payment method required"
                      : "Managed by Stripe"}
                  </p>
                  <p className="text-xs text-[#687896]">Secure hosted billing</p>
                </div>
                <Button
                  className="rounded-full bg-[#e8f1ff] text-[#135fdd] hover:bg-[#d9e8ff]"
                  disabled={busy}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={onPortal}
                >
                  Update
                </Button>
              </div>
            </GlassPanel>

            <GlassPanel>
              <h2 className="font-bold">Billing History</h2>
              <div className="mt-4 rounded-xl border border-[#dbe4f0] bg-white/50 p-4 text-sm">
                {summary.period === null ? (
                  <p className="text-[#687896]">No active billing period.</p>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <span>{formatDate(summary.period.startsAt)}</span>
                    <span className="text-[#687896]">{currentPlan} Plan</span>
                    <strong>{summary.currentPlan === "free" ? "$0" : "CA$25"}</strong>
                  </div>
                )}
              </div>
              <button
                className="mt-4 min-h-11 font-semibold text-[#135fdd] hover:underline focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none"
                type="button"
                onClick={onPortal}
              >
                View invoices in secure billing →
              </button>
            </GlassPanel>

            <GlassPanel>
              <h2 className="font-bold">Promo Code</h2>
              <div className="mt-3 flex gap-3">
                <input
                  aria-label="Promo code, unavailable"
                  className="min-h-11 min-w-0 flex-1 cursor-not-allowed rounded-xl border border-[#d5e0ee] bg-white/60 px-3 text-sm"
                  disabled
                  placeholder="Promo codes are not available"
                />
                <Button className="rounded-full" disabled type="button" variant="secondary">
                  Apply
                </Button>
              </div>
            </GlassPanel>
          </div>
        </div>

        <p className="mt-5 text-sm">{paymentMessage(summary)}</p>
        {summary.pendingPlan === null ? null : (
          <p className="mt-3 rounded-2xl border border-amber-300 bg-amber-50/80 p-4 font-semibold text-amber-950">
            {summary.pendingPlan.plan === "free" ? "Free" : "Adventurer"} starts{" "}
            {formatDate(summary.pendingPlan.effectiveAt)}.
          </p>
        )}
        {summary.currentPlan === "free" ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button disabled={busy} onClick={onCheckout} type="button">
              Continue to secure checkout
            </Button>
            <p className="text-sm text-[#687896]">Adventurer is CA$25 each month, plus tax.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const planFeatures = (plan: BillingSummary["currentPlan"]): ReadonlyArray<string> =>
  plan === "free"
    ? ["Personal Osfo Agent", "WhatsApp messaging", "Private memory"]
    : [
        "Personal Osfo Agent",
        "Expanded message allowance",
        "Advanced automations",
        "Priority support",
        "Custom integrations",
      ];

const paymentMessage = (summary: BillingSummary) => {
  switch (summary.paymentState) {
    case "paid":
      return "Your paid access is active.";
    case "changeScheduled":
      return "Your current Plan stays active until the scheduled change.";
    case "paymentNeeded":
      return "Payment needs attention before paid access can start.";
    case "free":
      return "No card is required for Free.";
    default:
      return "Billing status is unavailable.";
  }
};

const formatDate = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: "UTC" }).format(date);
