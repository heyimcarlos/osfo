import { Context, Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
  OpenApi,
} from "effect/unstable/httpapi";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const Uuid = Schema.String.check(Schema.isUUID());

const MessageContent = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(16_384));

const IsoTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
);

export const SubmitMessagePayload = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  idempotencyKey: Uuid,
  message: Schema.Struct({ content: MessageContent }),
}).annotate(strict);

export type SubmitMessagePayload = typeof SubmitMessagePayload.Type;

export class AcceptanceReceipt extends Schema.Class<AcceptanceReceipt>("AcceptanceReceipt")(
  {
    protocolVersion: Schema.Literal(1),
    receiptId: Uuid,
    idempotencyKey: Uuid,
    threadId: Uuid,
    userMessageId: Uuid,
    agentRunId: Uuid,
    threadPosition: Schema.String.check(Schema.isPattern(/^[1-9]\d*$/u)),
    acceptedAt: IsoTimestamp,
  },
  strict,
) {}

export class MalformedRequest extends Schema.TaggedErrorClass<MalformedRequest>()(
  "MalformedRequest",
  {},
  { httpApiStatus: 400 },
) {}

export class AuthenticationRejected extends Schema.TaggedErrorClass<AuthenticationRejected>()(
  "AuthenticationRejected",
  {},
  { httpApiStatus: 401 },
) {}

export class ThreadNotFound extends Schema.TaggedErrorClass<ThreadNotFound>()(
  "ThreadNotFound",
  {},
  { httpApiStatus: 404 },
) {}

export class IdempotencyConflict extends Schema.TaggedErrorClass<IdempotencyConflict>()(
  "IdempotencyConflict",
  {},
  { httpApiStatus: 409 },
) {}

export class CapacityRejected extends Schema.TaggedErrorClass<CapacityRejected>()(
  "CapacityRejected",
  { scope: Schema.Literals(["global", "principal"]) },
  { httpApiStatus: 429 },
) {}

export class AdmissionUnavailable extends Schema.TaggedErrorClass<AdmissionUnavailable>()(
  "AdmissionUnavailable",
  {},
  { httpApiStatus: 503 },
) {}

export class AuthenticationToken extends Context.Service<AuthenticationToken, string>()(
  "@osfo/api/AuthenticationToken",
) {}

export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: AuthenticationToken; clientError: never }
>()("@osfo/api/Authentication", {
  error: AuthenticationRejected,
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
}) {}

export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  "@osfo/api/RequestValidation",
  { error: MalformedRequest },
) {}

export const ThreadsApi = HttpApiGroup.make("threads")
  .add(
    HttpApiEndpoint.post("submitMessage", "/v1/threads/:threadId/messages", {
      params: { threadId: Uuid },
      payload: SubmitMessagePayload,
      success: AcceptanceReceipt,
      error: [ThreadNotFound, IdempotencyConflict, CapacityRejected, AdmissionUnavailable],
    }),
  )
  .middleware(Authentication)
  .middleware(RequestValidation)
  .annotateMerge(
    OpenApi.annotations({
      title: "Threads",
      description: "Submit input to an Osfo Thread.",
    }),
  );
