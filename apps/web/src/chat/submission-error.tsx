import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { ThreadChatSubmission } from "./atoms";

export function SubmissionError({ submission }: { readonly submission: ThreadChatSubmission }) {
  if (!AsyncResult.isFailure(submission)) return null;

  const message = Option.match(Cause.findErrorOption(submission.cause), {
    onNone: () => "The message could not be accepted. Try again.",
    onSome: (error) =>
      Match.value(error).pipe(
        Match.tag(
          "CommitUnknown",
          () => "The receipt was interrupted. Retry to reconcile with the same idempotency key.",
        ),
        Match.tag("AuthenticationRejected", () => "The reference session is not authenticated."),
        Match.tag("ThreadNotFound", () => "This Thread is unavailable to the reference session."),
        Match.tag(
          "IdempotencyConflict",
          () => "That retry key already belongs to a different message.",
        ),
        Match.tag("CapacityRejected", () => "Thread admission is currently at capacity."),
        Match.tag("AdmissionUnavailable", () => "Durable admission is temporarily unavailable."),
        Match.tag("MalformedRequest", () => "The message does not match the Thread contract."),
        Match.exhaustive,
      ),
  });

  return (
    <p role="alert" className="mt-2 px-2 text-xs leading-5 text-destructive">
      {message}
    </p>
  );
}
