/* oxlint-disable effecttsgo/strict-effect-provide -- This composed test is the entry point for its concrete HTTP client Layer. */
import { expect, it } from "@effect/vitest";
import {
  AccountDeletionAction,
  type AccountDeletionRequest,
} from "@osfo/api";
import { Config, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import postgres from "postgres";

const RegistrationResponse = Schema.Struct({ userId: Schema.String });
const AccountDeletionPending = Schema.Struct({ status: Schema.Literal("deletion-pending") });
const RetainedActionState = Schema.Struct({
  access_fence_exists: Schema.Boolean,
  action_unconsumed: Schema.Boolean,
  auth_session_exists: Schema.Boolean,
  deletion_case_exists: Schema.Boolean,
  user_exists: Schema.Boolean,
});

interface PhoneOtpRequest {
  readonly phoneNumber: string;
}

interface PhoneOtpVerificationRequest extends PhoneOtpRequest {
  readonly code: string;
}

interface RegistrationRequest {
  readonly helpAreas: ReadonlyArray<string>;
  readonly locale: "en";
  readonly preferredName: string;
}

interface EditedAccountDeletionRequest {
  readonly approval: {
    readonly decision: "approved";
    readonly presentation: {
      readonly actionId: string;
      readonly confirmation: string;
      readonly consequence: string;
      readonly operation: "account.delete";
      readonly title: string;
    };
  };
  readonly confirmation: string;
  readonly presentationVersion: string;
  readonly replayToken: string;
}

type ComposedRequestBody =
  | AccountDeletionRequest
  | EditedAccountDeletionRequest
  | PhoneOtpRequest
  | PhoneOtpVerificationRequest
  | RegistrationRequest;

type RequestMethod = "DELETE" | "GET" | "POST" | "PUT";

it.effect("rejects one edited retained envelope without consuming its Action", () =>
  Effect.gen(function* () {
    const workerOrigin = yield* Config.string("OSFO_TEST_WORKER_URL");
    const databaseUrl = yield* Config.string("OSFO_TEST_DATABASE_URL");
    const phoneNumber = yield* Config.string("OSFO_TEST_PHONE_NUMBER");
    const httpClient = yield* HttpClient.HttpClient;
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => postgres(databaseUrl, { max: 1, prepare: false })),
      (database) => Effect.promise(() => database.end({ timeout: 0 })),
    );
    let cookie = "";
    const request = Effect.fn("AccountDeletionEnvelopeTest.request")(function* (
      method: RequestMethod,
      path: string,
      body?: ComposedRequestBody,
    ) {
      let httpRequest = HttpClientRequest.make(method)(`${workerOrigin}${path}`).pipe(
        HttpClientRequest.setHeader("origin", "https://osfo.test"),
      );
      if (cookie.length > 0) {
        httpRequest = httpRequest.pipe(HttpClientRequest.setHeader("cookie", cookie));
      }
      if (body !== undefined) {
        httpRequest = yield* HttpClientRequest.bodyJson(httpRequest, body);
      }
      return yield* httpClient.execute(httpRequest);
    });

    const sent = yield* request("POST", "/auth/phone-number/send-otp", { phoneNumber });
    expect(sent.status).toBe(200);
    const verified = yield* request("POST", "/auth/phone-number/verify", {
      code: "424242",
      phoneNumber,
    });
    expect(verified.status).toBe(200);
    cookie = verified.headers["set-cookie"]?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");

    const registered = yield* request("PUT", "/v1/registration", {
      helpAreas: [],
      locale: "en",
      preferredName: "Envelope Proof",
    });
    expect(registered.status).toBe(200);
    const { userId } = yield* Schema.decodeUnknownEffect(RegistrationResponse)(
      yield* registered.json,
    );
    const presented = yield* request("GET", "/v1/account/deletion-action");
    expect(presented.status).toBe(200);
    const action = yield* Schema.decodeUnknownEffect(AccountDeletionAction)(
      yield* presented.json,
    );
    const exact = {
      approval: { decision: "approved" as const, presentation: action.presentation },
      confirmation: action.presentation.confirmation,
      presentationVersion: action.presentationVersion,
      replayToken: action.replayToken,
    } satisfies AccountDeletionRequest;
    const edited = {
      ...exact,
      approval: {
        ...exact.approval,
        presentation: {
          ...exact.approval.presentation,
          confirmation: "edited inner confirmation",
          consequence: "Edited destructive consequence.",
          title: "Edited Account Deletion",
        },
      },
      confirmation: "edited top-level confirmation",
    };

    const rejected = yield* request("DELETE", "/v1/account", edited);
    expect(rejected.status).toBe(400);
    yield* rejected.text;
    const [persisted] = yield* Effect.promise(
      () => client`
      select
        exists(
          select 1 from account_deletion_actions
          where user_id = ${userId}
            and action_id = ${action.presentation.actionId}
            and consumed_at is null
        ) as action_unconsumed,
        exists(select 1 from users where id = ${userId}) as user_exists,
        exists(select 1 from sessions where user_id = ${userId}) as auth_session_exists,
        exists(select 1 from deletion_cases where user_id = ${userId}) as deletion_case_exists,
        exists(
          select 1 from deletion_cases
          where user_id = ${userId}
            and access_fenced_at is not null
        ) as access_fence_exists
    `,
    );
    expect(yield* Schema.decodeUnknownEffect(RetainedActionState)(persisted)).toEqual({
      access_fence_exists: false,
      action_unconsumed: true,
      auth_session_exists: true,
      deletion_case_exists: false,
      user_exists: true,
    });

    const accepted = yield* request("DELETE", "/v1/account", exact);
    expect(accepted.status).toBe(200);
    expect(
      yield* Schema.decodeUnknownEffect(AccountDeletionPending)(
        yield* accepted.json,
      ),
    ).toEqual({ status: "deletion-pending" });
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
