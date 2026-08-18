import type { BillingSummary } from "@osfo/api";
import { Button } from "@osfo/ui/components/button";
import { Link } from "@tanstack/react-router";

/** Safe Plan and hosted-billing actions for one authenticated User. */
export function BillingScreen({
  busy = false,
  presentation = "standalone",
  onCheckout,
  onPortal,
  summary,
}: {
  readonly busy?: boolean;
  readonly presentation?: "settings" | "standalone";
  readonly onCheckout: () => void;
  readonly onPortal: () => void;
  readonly summary: BillingSummary;
}) {
  const currentPlan = summary.currentPlan === "adventurer" ? "Adventurer" : "Free";
  return (
    <main
      className={
        presentation === "settings"
          ? "text-foreground"
          : "min-h-dvh bg-background px-5 py-10 text-foreground"
      }
    >
      <section className="mx-auto max-w-2xl space-y-6">
        {presentation === "settings" ? null : (
          <Link className="font-bold underline" to="/">
            Back to Osfo
          </Link>
        )}
        <div className="space-y-2">
          <p className="text-sm font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Billing
          </p>
          <h1 className="text-4xl font-black uppercase sm:text-6xl">{currentPlan}</h1>
          <p>{paymentMessage(summary)}</p>
        </div>
        {summary.period === null ? null : (
          <dl className="grid gap-4 rounded-2xl border-2 p-5 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-bold text-muted-foreground">Current period started</dt>
              <dd className="text-lg font-bold">{formatDate(summary.period.startsAt)}</dd>
            </div>
            <div>
              <dt className="text-sm font-bold text-muted-foreground">Current period ends</dt>
              <dd className="text-lg font-bold">{formatDate(summary.period.endsAt)}</dd>
            </div>
          </dl>
        )}
        {summary.pendingPlan === null ? null : (
          <p className="rounded-2xl border-2 border-amber-500 bg-amber-50 p-4 font-bold text-amber-950">
            {summary.pendingPlan.plan === "free" ? "Free" : "Adventurer"} starts{" "}
            {formatDate(summary.pendingPlan.effectiveAt)}.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {summary.currentPlan === "free" ? (
            <Button disabled={busy} onClick={onCheckout} type="button">
              Continue to secure checkout
            </Button>
          ) : null}
          <Button disabled={busy} onClick={onPortal} type="button" variant="outline">
            Manage billing
          </Button>
        </div>
        {summary.currentPlan === "free" ? (
          <p className="text-sm text-muted-foreground">Adventurer is CA$25 each month, plus tax.</p>
        ) : null}
      </section>
    </main>
  );
}

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
