/* oxlint-disable effecttsgo/async-function -- Cloudflare WorkflowStep is a Promise-only host API. */
/* oxlint-disable eslint/no-underscore-dangle -- Deadline outcomes use the canonical tagged discriminator. */

/** Keep deadline cleanup ahead of the first terminal User follow-up on every host replay. */
export const settleDeadlineOutcome = async <A, D, R>(
  deadline: { readonly _tag: string; readonly report: R & { readonly state: string } },
  discard: (report: R) => Promise<D>,
  claimTerminal: () => Promise<A>,
): Promise<A> => {
  if (deadline._tag === "Canceled" || deadline.report.state === "canceled") {
    await discard(deadline.report);
  }
  return claimTerminal();
};

export * as ResearchReportTimerOutcome from "./research-report-timer-outcome";
