import { Effect, Layer, Schema } from "effect";

import { SubmitManagedConversationInput } from "../../services/managed-conversation";
import * as MessagingAdmission from "../../services/messaging-admission";

const SubmissionAcceptedResult = Schema.StructWithRest(
  Schema.Struct({
    accepted: Schema.Boolean,
    status: Schema.Literals(["aborted", "completed", "error", "pending", "running", "skipped"]),
    submissionId: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** Closed RPC result surface. Non-accepted tagged results fail at the adapter decoder. */
type AgentSubmissionResponse = typeof SubmissionAcceptedResult.Type | { readonly _tag: string };

interface AgentSubmissionStub {
  readonly submitManagedConversation: (
    input: typeof SubmitManagedConversationInput.Encoded,
  ) => Promise<AgentSubmissionResponse>;
}

interface DurableNamespace<Stub> {
  readonly getByName: (identity: string) => Stub;
}

/** Named Agent binding used for transport-neutral message admission. */
export interface Bindings {
  readonly OSFO_AGENT: DurableNamespace<AgentSubmissionStub>;
}

/** Submit to the existing named Osfo Agent without creating a messenger sub-agent. */
export const layer = (env: Bindings) =>
  Layer.succeed(
    MessagingAdmission.AgentSubmission,
    MessagingAdmission.AgentSubmission.of({
      submit: (agentId, input) =>
        Schema.encodeEffect(SubmitManagedConversationInput)(input).pipe(
          Effect.flatMap((encoded) =>
            Effect.tryPromise({
              try: () => env.OSFO_AGENT.getByName(agentId).submitManagedConversation(encoded),
              catch: (cause) => unavailable("submitThinkMessages", cause),
            }),
          ),
          Effect.flatMap(Schema.decodeUnknownEffect(SubmissionAcceptedResult)),
          Effect.mapError((cause) => unavailable("submitThinkMessages", cause)),
          Effect.map((result) => ({ accepted: result.accepted })),
        ),
    }),
  );

const unavailable = (operation: string, cause: unknown) =>
  new MessagingAdmission.MessagingAdmissionUnavailable({
    cause,
    message: "The stable Osfo Agent could not accept the message",
    operation,
  });
