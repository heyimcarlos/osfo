/** Supported locale parsed from an untrusted router search record. */
export type LocaleSearch = { readonly lang: "en" | "es" };

/** Parse the public locale query and default unsupported values to English. */
export const parseLocaleSearch = (search: { readonly lang?: unknown }): LocaleSearch => ({
  lang: search.lang === "es" ? "es" : "en",
});

/** Optional explicit setup locale, absent when browser language must decide. */
export type RegistrationSearch = {
  readonly lang?: "en" | "es";
  readonly returnTo?: string;
};

const ChannelLinkReturnPath = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^\/verify\/[A-Za-z0-9]{8}$/u.test(value) || "must be a local Channel Link invite path",
  ),
);

/** Parse an explicit setup locale while preserving the browser-language fallback when absent. */
export const parseRegistrationSearch = (search: {
  readonly lang?: unknown;
  readonly returnTo?: unknown;
}): RegistrationSearch => {
  const lang = search.lang === "en" || search.lang === "es" ? search.lang : undefined;
  const returnTo = Option.getOrUndefined(
    Schema.decodeUnknownOption(ChannelLinkReturnPath)(search.returnTo),
  );
  if (lang !== undefined && returnTo !== undefined) return { lang, returnTo };
  if (lang !== undefined) return { lang };
  if (returnTo !== undefined) return { returnTo };
  return {};
};
import { Option, Schema } from "effect";
