import { isTextUIPart, type UIMessage } from "ai";
import { Predicate } from "effect";

/** Maximum delay between checks for Channel Link acceptance. */
export const ACCEPTANCE_TEARDOWN_MS = 6 * 60 * 60 * 1_000;

/** Maximum idle lifetime of one Company Conversation. */
const IDLE_TEARDOWN_MS = 24 * 60 * 60 * 1_000;

/** Retry delay when Channel Link authority cannot be read at teardown time. */
const TEARDOWN_UNCERTAIN_RETRY_MS = 30 * 60 * 1_000;

/** Model-visible and durable messages retained for one linking attempt. */
export const TRANSCRIPT_WINDOW_MESSAGES = 12;

const INVITE_REDACTION = "[invite removed]";
const INVITE_URL_PATTERN = /(?:https?:\/\/[^\s/]+)?\/verify\/[A-Za-z0-9_-]+/giu;

export type TeardownDecision =
  | { readonly _tag: "Destroy" }
  | { readonly _tag: "Wait"; readonly at: Date };

/** Remove bearer invitation URLs before Think can persist or infer over a sender message. */
export const sanitizeCompanyMessage = (message: string | UIMessage): string | UIMessage => {
  if (Predicate.isString(message)) return redactInviteUrls(message);
  return {
    id: message.id,
    parts: message.parts.flatMap((part) =>
      isTextUIPart(part) ? [{ text: redactInviteUrls(part.text), type: "text" as const }] : [],
    ),
    role: message.role,
  };
};

/** Read only sanitized current-User text when authorizing a public query. */
export const companyMessageText = (message: string | UIMessage): string =>
  Predicate.isString(message)
    ? message
    : message.parts.flatMap((part) => (isTextUIPart(part) ? [part.text] : [])).join("\n");

/** Publish Company search only with both price evidence and an address cap. */
export const companyPublicSearchAvailable = (
  hasRecognizedPrice: boolean,
  dailyLimit: number | null,
): boolean => hasRecognizedPrice && dailyLimit !== null;

/** Bound a model turn to the most recent window that starts on a user boundary. */
export const boundedTranscriptWindow = <T extends { readonly role: string }>(
  messages: ReadonlyArray<T>,
  keep: number,
): Array<T> => {
  if (messages.length <= keep) return [...messages];
  const earliest = messages.length - keep;
  const firstUserAtOrAfter = messages.findIndex(
    (message, index) => index >= earliest && message.role === "user",
  );
  return messages.slice(firstUserAtOrAfter < 0 ? earliest : firstUserAtOrAfter);
};

/** Select durable message ids that must be deleted to enforce the transcript ceiling. */
export const transcriptMessagesToPrune = (
  messages: ReadonlyArray<{ readonly id: string }>,
  keep: number,
): Array<string> => messages.slice(0, Math.max(0, messages.length - keep)).map(({ id }) => id);

/** Decide the next expiry-only lifecycle wakeup for one Company Conversation. */
export const planTeardown = (input: {
  readonly lastActivityAt: Date;
  readonly linked: boolean | null;
  readonly now: Date;
}): TeardownDecision => {
  if (input.linked === true) return { _tag: "Destroy" };
  if (input.linked === null || isNaN(input.lastActivityAt.getTime())) {
    // oxlint-disable-next-line effecttsgo/global-date -- Think schedules use JavaScript Date values.
    return { _tag: "Wait", at: new Date(input.now.getTime() + TEARDOWN_UNCERTAIN_RETRY_MS) };
  }
  const idleMs = input.now.getTime() - input.lastActivityAt.getTime();
  if (idleMs >= IDLE_TEARDOWN_MS) return { _tag: "Destroy" };
  const acceptanceCheckNumber = Math.max(
    1,
    Math.floor(Math.max(0, idleMs) / ACCEPTANCE_TEARDOWN_MS) + 1,
  );
  const acceptanceCheckAt =
    input.lastActivityAt.getTime() + acceptanceCheckNumber * ACCEPTANCE_TEARDOWN_MS;
  const idleDeadline = input.lastActivityAt.getTime() + IDLE_TEARDOWN_MS;
  // oxlint-disable-next-line effecttsgo/global-date -- Think schedules use JavaScript Date values.
  return { _tag: "Wait", at: new Date(Math.min(acceptanceCheckAt, idleDeadline)) };
};

/** Redact invitation URLs from text that may cross a diagnostic boundary. */
export const redactInviteUrls = (text: string): string =>
  text.replace(INVITE_URL_PATTERN, INVITE_REDACTION);
