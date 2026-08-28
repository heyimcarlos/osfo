/** Keep Cloudflare's step retry active while PostgreSQL still owns recoverable work. */
export const requireRetryForRecoverableResult = <A extends object>(result: A): A => {
  if ("failure" in result && (result.failure === "recovery" || result.failure === "unavailable")) {
    throw new Error(
      result.failure === "recovery"
        ? "Research Report reconciliation is pending"
        : "Research Report execution host is temporarily unavailable",
    );
  }
  return result;
};
