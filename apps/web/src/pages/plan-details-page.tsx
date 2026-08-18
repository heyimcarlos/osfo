import { useSearch } from "@tanstack/react-router";

import { PlanDetails } from "../components/public-information";

/** Route-owned public Plan details. */
export function PlanDetailsPage() {
  const { lang } = useSearch({ from: "/plans" });
  return <PlanDetails locale={lang} />;
}
