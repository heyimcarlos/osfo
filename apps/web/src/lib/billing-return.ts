import { Option, Schema } from "effect";

/* oxlint-disable eslint/no-underscore-dangle -- Typed route states use the standard _tag discriminator. */

const BillingReturnQuery = Schema.Struct({
  session_id: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
});

/** Legal states parsed from a hosted billing return query. */
export type BillingReturnSearch =
  | { readonly _tag: "Checkout"; readonly checkoutSessionId: string }
  | { readonly _tag: "Invalid" }
  | { readonly _tag: "Ordinary" }
  | { readonly _tag: "Portal" };

/** Raw browser query accepted by the billing settings route. */
export type BillingReturnQueryInput = {
  readonly session_id?: unknown;
  readonly source?: unknown;
};

/** Parse unknown hosted billing query data into one legal return state. */
export const parseBillingReturnSearch = (input: BillingReturnQueryInput): BillingReturnSearch => {
  const decoded = Schema.decodeUnknownOption(BillingReturnQuery)(input);
  if (Option.isNone(decoded)) return { _tag: "Invalid" };
  const { session_id: sessionId, source } = decoded.value;
  if (source === undefined && sessionId === undefined) return { _tag: "Ordinary" };
  if (source === "portal" && sessionId === undefined) return { _tag: "Portal" };
  if (source === "checkout" && sessionId !== undefined && sessionId.length > 0)
    return { _tag: "Checkout", checkoutSessionId: sessionId };
  return { _tag: "Invalid" };
};

/** Parse the browser's encoded billing query without trusting router inference. */
export const parseBillingReturnSearchString = (search: string): BillingReturnSearch => {
  const query = new URLSearchParams(search);
  return parseBillingReturnSearch({
    session_id: query.get("session_id") ?? undefined,
    source: query.get("source") ?? undefined,
  });
};

/** Preserve a validated legacy billing return while redirecting into Settings. */
export const billingReturnQuery = (state: BillingReturnSearch): BillingReturnQueryInput => {
  switch (state._tag) {
    case "Checkout":
      return { session_id: state.checkoutSessionId, source: "checkout" };
    case "Portal":
      return { source: "portal" };
    case "Invalid":
      return { source: "invalid" };
    case "Ordinary":
      return {};
  }
  state satisfies never;
  return {};
};
