import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export interface SubmitMessageCommand {
  readonly protocolVersion: 1;
  readonly authenticationToken: string;
  readonly threadId: string;
  readonly idempotencyKey: string;
  readonly message: {
    readonly content: string;
  };
}

export class AcceptanceReceipt {
  readonly protocolVersion: 1;
  readonly receiptId: string;
  readonly idempotencyKey: string;
  readonly threadId: string;
  readonly userMessageId: string;
  readonly agentRunId: string;
  readonly threadPosition: string;
  readonly acceptedAt: string;

  constructor(properties: AcceptanceReceipt) {
    this.protocolVersion = properties.protocolVersion;
    this.receiptId = properties.receiptId;
    this.idempotencyKey = properties.idempotencyKey;
    this.threadId = properties.threadId;
    this.userMessageId = properties.userMessageId;
    this.agentRunId = properties.agentRunId;
    this.threadPosition = properties.threadPosition;
    this.acceptedAt = properties.acceptedAt;
  }
}

export class AuthenticationRejected extends Data.TaggedError("AuthenticationRejected") {}

export class ThreadNotFound extends Data.TaggedError("ThreadNotFound") {}

export class IdempotencyConflict extends Data.TaggedError("IdempotencyConflict") {}

export class CapacityRejected extends Data.TaggedError("CapacityRejected")<{
  readonly scope: "global" | "principal";
}> {}

export class AdmissionUnavailable extends Data.TaggedError("AdmissionUnavailable") {}

export class CommitUnknown extends Data.TaggedError("CommitUnknown") {}

export class InvalidTransportResponse extends Data.TaggedError("InvalidTransportResponse") {}

export type MessageAdmissionError =
  | AuthenticationRejected
  | ThreadNotFound
  | IdempotencyConflict
  | CapacityRejected
  | AdmissionUnavailable;

export class MessageAdmission extends Context.Service<
  MessageAdmission,
  {
    readonly accept: (
      command: SubmitMessageCommand,
    ) => Effect.Effect<AcceptanceReceipt, MessageAdmissionError>;
  }
>()("@osfo/native-thread-transport/MessageAdmission") {}

interface Problem {
  readonly protocolVersion: 1;
  readonly type:
    | "malformed_request"
    | "authentication_rejected"
    | "thread_not_found"
    | "idempotency_conflict"
    | "capacity_rejected"
    | "admission_unavailable";
  readonly title: string;
  readonly retryable: boolean;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const exactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeBody = (value: unknown) => {
  if (!isRecord(value) || !exactKeys(value, ["protocolVersion", "idempotencyKey", "message"])) {
    return undefined;
  }
  if (value.protocolVersion !== 1 || typeof value.idempotencyKey !== "string") {
    return undefined;
  }
  if (!uuidPattern.test(value.idempotencyKey) || !isRecord(value.message)) {
    return undefined;
  }
  if (!exactKeys(value.message, ["content"]) || typeof value.message.content !== "string") {
    return undefined;
  }
  if (value.message.content.length === 0 || value.message.content.length > 16_384) {
    return undefined;
  }
  return {
    protocolVersion: 1 as const,
    idempotencyKey: value.idempotencyKey,
    message: { content: value.message.content },
  };
};

const problemResponse = (status: number, problem: Problem) => Response.json(problem, { status });

const malformedRequest = () =>
  problemResponse(400, {
    protocolVersion: 1,
    type: "malformed_request",
    title: "Malformed request",
    retryable: false,
  });

const admissionProblemResponses = {
  AuthenticationRejected: {
    status: 401,
    problem: {
      protocolVersion: 1,
      type: "authentication_rejected",
      title: "Authentication rejected",
      retryable: false,
    },
  },
  ThreadNotFound: {
    status: 404,
    problem: {
      protocolVersion: 1,
      type: "thread_not_found",
      title: "Thread not found",
      retryable: false,
    },
  },
  IdempotencyConflict: {
    status: 409,
    problem: {
      protocolVersion: 1,
      type: "idempotency_conflict",
      title: "Idempotency conflict",
      retryable: false,
    },
  },
  CapacityRejected: {
    status: 429,
    problem: {
      protocolVersion: 1,
      type: "capacity_rejected",
      title: "Capacity rejected",
      retryable: true,
    },
  },
  AdmissionUnavailable: {
    status: 503,
    problem: {
      protocolVersion: 1,
      type: "admission_unavailable",
      title: "Admission unavailable",
      retryable: true,
    },
  },
} as const satisfies Record<
  MessageAdmissionError["_tag"],
  { readonly status: number; problem: Problem }
>;

const admissionErrorTags = new Set(Object.keys(admissionProblemResponses));

export const isMessageAdmissionError = (error: unknown): error is MessageAdmissionError => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) {
    return false;
  }
  return typeof error._tag === "string" && admissionErrorTags.has(error._tag);
};

const errorResponse = (cause: unknown) => {
  const error = isMessageAdmissionError(cause) ? cause : new AdmissionUnavailable();
  const response = admissionProblemResponses[error._tag];
  return problemResponse(response.status, response.problem);
};

const decodeAuthenticationToken = (request: Request) => {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 ? token : undefined;
};

const decodeThreadId = (request: Request) => {
  const match = new URL(request.url).pathname.match(/^\/v1\/threads\/([^/]+)\/messages$/u);
  const threadId = match?.[1];
  return threadId !== undefined && uuidPattern.test(threadId) ? threadId : undefined;
};

export const makeNativeThreadRequestHandler = <Error, Requirements>(
  accept: (command: SubmitMessageCommand) => Effect.Effect<AcceptanceReceipt, Error, Requirements>,
) =>
  Effect.fn("NativeThreadTransport.handleRequest")(function* (request: Request) {
    if (request.method !== "POST") {
      return malformedRequest();
    }

    const authenticationToken = decodeAuthenticationToken(request);
    if (authenticationToken === undefined) {
      return errorResponse(new AuthenticationRejected());
    }

    const threadId = decodeThreadId(request);
    if (threadId === undefined) {
      return malformedRequest();
    }

    const json = yield* Effect.tryPromise({
      try: () => request.json() as Promise<unknown>,
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const body = decodeBody(json);
    if (body === undefined) {
      return malformedRequest();
    }

    return yield* accept({
      ...body,
      authenticationToken,
      threadId,
    }).pipe(
      Effect.match({
        onFailure: errorResponse,
        onSuccess: (accepted) => Response.json(accepted, { status: 200 }),
      }),
    );
  });

export const handleNativeThreadRequest = (request: Request) =>
  makeNativeThreadRequestHandler((command) =>
    MessageAdmission.use((admission) => admission.accept(command)),
  )(request);

export interface SubmitThreadMessage {
  readonly endpoint: string;
  readonly authenticationToken: string;
  readonly threadId: string;
  readonly idempotencyKey: string;
  readonly message: {
    readonly content: string;
  };
}

export class NativeThreadProblem extends Data.TaggedError("NativeThreadProblem")<{
  readonly status: number;
  readonly problem: Problem;
}> {}

export type NativeThreadClientError =
  | CommitUnknown
  | InvalidTransportResponse
  | NativeThreadProblem;

export type NativeThreadFetch = (request: Request) => Promise<Response>;

const problemTypes = new Set<Problem["type"]>([
  "malformed_request",
  "authentication_rejected",
  "thread_not_found",
  "idempotency_conflict",
  "capacity_rejected",
  "admission_unavailable",
]);

const decodeProblem = (value: unknown): Problem | undefined => {
  if (!isRecord(value) || !exactKeys(value, ["protocolVersion", "type", "title", "retryable"])) {
    return undefined;
  }
  if (
    value.protocolVersion !== 1 ||
    typeof value.type !== "string" ||
    !problemTypes.has(value.type as Problem["type"]) ||
    typeof value.title !== "string" ||
    typeof value.retryable !== "boolean"
  ) {
    return undefined;
  }
  return value as unknown as Problem;
};

const decodeReceipt = (value: unknown, command: SubmitThreadMessage) => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "protocolVersion",
      "receiptId",
      "idempotencyKey",
      "threadId",
      "userMessageId",
      "agentRunId",
      "threadPosition",
      "acceptedAt",
    ])
  ) {
    return undefined;
  }
  if (
    value.protocolVersion !== 1 ||
    typeof value.receiptId !== "string" ||
    !uuidPattern.test(value.receiptId) ||
    value.idempotencyKey !== command.idempotencyKey ||
    value.threadId !== command.threadId ||
    typeof value.userMessageId !== "string" ||
    !uuidPattern.test(value.userMessageId) ||
    typeof value.agentRunId !== "string" ||
    !uuidPattern.test(value.agentRunId) ||
    typeof value.threadPosition !== "string" ||
    !/^[1-9]\d*$/u.test(value.threadPosition) ||
    typeof value.acceptedAt !== "string" ||
    Number.isNaN(Date.parse(value.acceptedAt))
  ) {
    return undefined;
  }
  return new AcceptanceReceipt(value as unknown as AcceptanceReceipt);
};

export const submitThreadMessage = Effect.fn("NativeThreadTransport.submitThreadMessage")(
  function* (command: SubmitThreadMessage, fetchRequest: NativeThreadFetch = globalThis.fetch) {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchRequest(
          new Request(command.endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${command.authenticationToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              protocolVersion: 1,
              idempotencyKey: command.idempotencyKey,
              message: command.message,
            }),
          }),
        ),
      catch: () => new CommitUnknown(),
    });
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => (response.ok ? new CommitUnknown() : new InvalidTransportResponse()),
    });

    if (response.ok) {
      const receipt = decodeReceipt(body, command);
      return receipt === undefined ? yield* new CommitUnknown() : receipt;
    }

    const problem = decodeProblem(body);
    return problem === undefined
      ? yield* new InvalidTransportResponse()
      : yield* new NativeThreadProblem({ status: response.status, problem });
  },
);
