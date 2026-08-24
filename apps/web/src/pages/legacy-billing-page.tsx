import { Navigate, useRouterState } from "@tanstack/react-router";

import { billingReturnQuery, parseBillingReturnSearchString } from "../lib/billing-return";

/** Redirect the retired standalone billing URL into the settings dashboard. */
export function LegacyBillingPage() {
  return <Navigate replace search={{}} to="/settings/billing" />;
}

/** Preserve an in-flight hosted billing return while moving it into Settings. */
export function LegacyBillingReturnPage() {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const returnState = parseBillingReturnSearchString(search);
  return <Navigate replace search={billingReturnQuery(returnState)} to="/settings/billing" />;
}
