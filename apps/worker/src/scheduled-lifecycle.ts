/* oxlint-disable effecttsgo/async-function -- Promise.allSettled owns the Cloudflare scheduled lifecycle boundary. */

/** Keep every scheduled branch alive, then surface one safe aggregate failure. */
export const settleScheduledBranches = async (
  operations: ReadonlyArray<() => Promise<void>>,
): Promise<void> => {
  const results = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation)),
  );
  const failures = results.filter((result) => result.status === "rejected").length;
  if (failures > 0) throw new Error(`Scheduled maintenance failed in ${failures} branch(es)`);
};
