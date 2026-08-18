import { useSearch } from "@tanstack/react-router";

import { PrivacyNotice } from "../components/public-information";

/** Route-owned public privacy notice. */
export function PrivacyNoticePage() {
  const { lang } = useSearch({ from: "/privacy" });
  return <PrivacyNotice locale={lang} />;
}
