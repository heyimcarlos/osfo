/** Immutable Browser Run duration rate, excluding account-level concurrency overhead.
 * https://developers.cloudflare.com/browser-run/pricing/
 */
export const hostedBrowserPrice = {
  browserHourUsdMicros: 90_000n,
  resourcePriceVersion: "browser-duration-prices-2026-09-06",
} as const;

/** Round positive metered duration up to one USD micro at the retained resource rate. */
export const rateHostedBrowserDuration = (milliseconds: number): bigint =>
  (BigInt(Math.max(1, milliseconds)) * hostedBrowserPrice.browserHourUsdMicros + 3_599_999n) /
  3_600_000n;
