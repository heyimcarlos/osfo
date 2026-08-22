/** Supported locale parsed from an untrusted router search record. */
export type LocaleSearch = { readonly lang: "en" | "es" };

/** Parse the public locale query and default unsupported values to English. */
export const parseLocaleSearch = (search: { readonly lang?: unknown }): LocaleSearch => ({
  lang: search.lang === "es" ? "es" : "en",
});

/** Optional explicit setup locale, absent when browser language must decide. */
export type RegistrationSearch = {
  readonly lang?: "en" | "es";
};

/** Parse an explicit setup locale while preserving the browser-language fallback when absent. */
export const parseRegistrationSearch = (search: {
  readonly lang?: unknown;
}): RegistrationSearch => {
  const lang = search.lang === "en" || search.lang === "es" ? search.lang : undefined;
  if (lang !== undefined) return { lang };
  return {};
};
