import { useEffect } from "react";

/** Keep the document language synchronized with the route that owns localized content. */
export const useDocumentLanguage = (locale: "en" | "es" | null) => {
  useEffect(() => {
    if (locale !== null) document.documentElement.lang = locale;
  }, [locale]);
};
