import { ThreadEventEnvelopeSchema, ThreadSnapshotSchema } from "@osfo/session";
import { Context, Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
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

export class AdmissionCommitUnknown extends Schema.TaggedErrorClass<AdmissionCommitUnknown>()(
  "AdmissionCommitUnknown",
  {},
  { httpApiStatus: 503 },
) {}

export class AdmissionNotAccepted extends Schema.TaggedErrorClass<AdmissionNotAccepted>()(
  "AdmissionNotAccepted",
  {},
  { httpApiStatus: 404 },
) {}

export class InvalidCursor extends Schema.TaggedErrorClass<InvalidCursor>()(
  "InvalidCursor",
  {},
  { httpApiStatus: 400 },
) {}

export class CursorOutsideRetention extends Schema.TaggedErrorClass<CursorOutsideRetention>()(
  "CursorOutsideRetention",
  {},
  { httpApiStatus: 410 },
) {}

export class SnapshotUnavailable extends Schema.TaggedErrorClass<SnapshotUnavailable>()(
  "SnapshotUnavailable",
  {},
  { httpApiStatus: 503 },
) {}

export class ThreadResumeUnavailable extends Schema.TaggedErrorClass<ThreadResumeUnavailable>()(
  "ThreadResumeUnavailable",
  {},
  { httpApiStatus: 503 },
) {}

const NonNegativePosition = Schema.String.check(Schema.isPattern(/^\d+$/u));
const PositivePageLimit = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
);

export const ThreadHistoryPageSchema = Schema.Struct({
  threadId: Uuid,
  afterPosition: NonNegativePosition,
  throughPosition: NonNegativePosition,
  events: Schema.Array(ThreadEventEnvelopeSchema),
  nextAfterPosition: NonNegativePosition,
  hasMore: Schema.Boolean,
});

export type ThreadHistoryPage = typeof ThreadHistoryPageSchema.Type;

export const ThreadStreamEventSchema = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("thread_event"),
    data: Schema.fromJsonString(ThreadEventEnvelopeSchema),
  }),
  Schema.Struct({
    event: Schema.Literal("caught_up"),
    data: Schema.fromJsonString(
      Schema.Struct({
        throughPosition: NonNegativePosition,
        throughCursor: Schema.NonEmptyString,
      }),
    ),
  }),
]);

export type ThreadStreamEvent = typeof ThreadStreamEventSchema.Type;

const StreamSuccess = HttpApiSchema.StreamSse({
  contentType: "text/event-stream; charset=utf-8",
  events: ThreadStreamEventSchema,
  error: ThreadResumeUnavailable,
});

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
      error: [
        ThreadNotFound,
        IdempotencyConflict,
        CapacityRejected,
        AdmissionNotAccepted,
        AdmissionUnavailable,
        AdmissionCommitUnknown,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("reconcileMessageAdmission", "/v1/threads/:threadId/messages/reconcile", {
      params: { threadId: Uuid },
      payload: SubmitMessagePayload,
      success: AcceptanceReceipt,
      error: [ThreadNotFound, IdempotencyConflict, AdmissionNotAccepted, AdmissionCommitUnknown],
    }),
  )
  .add(
    HttpApiEndpoint.get("getSnapshot", "/v1/threads/:threadId/snapshot", {
      params: { threadId: Uuid },
      success: ThreadSnapshotSchema,
      error: [AuthenticationRejected, ThreadNotFound, SnapshotUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.get("getEvents", "/v1/threads/:threadId/events", {
      params: { threadId: Uuid },
      query: {
        after: Schema.optionalKey(Schema.NonEmptyString),
        afterPosition: Schema.optionalKey(NonNegativePosition),
        throughPosition: Schema.optionalKey(NonNegativePosition),
        limit: Schema.optionalKey(PositivePageLimit),
      },
      success: [ThreadHistoryPageSchema, StreamSuccess],
      error: [
        ThreadNotFound,
        AuthenticationRejected,
        InvalidCursor,
        CursorOutsideRetention,
        ThreadResumeUnavailable,
        MalformedRequest,
      ],
    }),
  )
  .middleware(Authentication)
  .middleware(RequestValidation)
  .annotateMerge(
    OpenApi.annotations({
      title: "Threads",
      description: "Submit input to and resume an Osfo Thread.",
    }),
  );
