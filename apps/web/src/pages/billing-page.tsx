import type { BillingSummary } from "@osfo/api";
import { Effect } from "effect";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useRouterState, useSearch } from "@tanstack/react-router";

import { BillingScreen } from "../components/billing-screen";
import {
  inspectBilling,
  openBillingPortal,
  reconcileBilling,
  startBillingCheckout,
} from "../lib/api-client";
import {
  billingReturnQuery,
  parseBillingReturnSearchString,
  type BillingReturnSearch,
} from "../lib/billing-return";

/* oxlint-disable eslint/no-underscore-dangle -- Typed billing return states use the standard _tag discriminator. */

/** Route-owned billing settings and hosted return handling. */
export function BillingPage() {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const returnState = useMemo(() => parseBillingReturnSearchString(search), [search]);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = billingLoad(returnState);
    if (load === null) {
      setError("Billing is temporarily unavailable. Please try again.");
      return;
    }
    void Effect.runPromise(load).then(setSummary, () =>
      setError("Billing is temporarily unavailable. Please try again."),
    );
  }, [returnState]);
  const redirect = (effect: typeof startBillingCheckout) => {
    setBusy(true);
    setError(null);
    void Effect.runPromise(effect).then(
      ({ url }) => globalThis.location.assign(url.href),
      () => {
        setBusy(false);
        setError("Billing is temporarily unavailable. Please try again.");
      },
    );
  };
  if (summary === null)
    return (
      <div className="grid min-h-64 place-items-center text-center">
        {error ?? "Loading billing..."}
      </div>
    );
  return (
    <div>
      {error === null ? null : <p role="alert">{error}</p>}
      <BillingScreen
        busy={busy}
        onCheckout={() => redirect(startBillingCheckout)}
        onPortal={() => redirect(openBillingPortal)}
        summary={summary}
      />
    </div>
  );
}

/** Redirect the retired standalone billing URL into the settings dashboard. */
export function LegacyBillingPage() {
  return <Navigate replace search={{}} to="/settings/billing" />;
}

/** Preserve an older hosted billing return while moving it into the settings dashboard. */
export function LegacyBillingReturnPage() {
  const returnState = useSearch({
    from: "/authenticated/billing/return",
  });
  return <Navigate replace search={billingReturnQuery(returnState)} to="/settings/billing" />;
}

const billingLoad = (returnState: BillingReturnSearch): typeof inspectBilling | null => {
  switch (returnState._tag) {
    case "Checkout":
      return reconcileBilling({
        reason: "checkoutReturn",
        stripeCheckoutSessionId: returnState.checkoutSessionId,
      }).pipe(Effect.andThen(inspectBilling));
    case "Portal":
      return reconcileBilling({ reason: "portalReturn" }).pipe(Effect.andThen(inspectBilling));
    case "Ordinary":
      return inspectBilling;
    case "Invalid":
      return null;
  }
  returnState satisfies never;
  return null;
};
