/* oxlint-disable effecttsgo/strict-effect-provide -- This composed test is the entry point for its concrete HTTP client Layer. */
import { expect, it } from "@effect/vitest";
import { AccountDeletionAction, type AccountDeletionRequest } from "@osfo/api";
import { Config, Effect, Ref, Schedule, Schema } from "effect";
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
const TerminalDeletionState = Schema.Struct({
  action_exists: Schema.Boolean,
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

interface CleanupState {
  readonly action?: AccountDeletionAction;
  readonly cookie: string;
  readonly userId?: string;
}

const isTerminallyDeleted = (state: typeof TerminalDeletionState.Type) =>
  !state.action_exists &&
  !state.auth_session_exists &&
  !state.deletion_case_exists &&
  !state.user_exists;

const toExactRequest = (action: AccountDeletionAction) =>
  ({
    approval: { decision: "approved" as const, presentation: action.presentation },
    confirmation: action.presentation.confirmation,
    presentationVersion: action.presentationVersion,
    replayToken: action.replayToken,
  }) satisfies AccountDeletionRequest;

it.effect("rejects an edited envelope and terminally removes the disposable identity", () =>
  Effect.gen(function* () {
    const workerOrigin = yield* Config.string("OSFO_TEST_WORKER_URL");
    const databaseUrl = yield* Config.string("OSFO_TEST_DATABASE_URL");
    const phoneNumber = yield* Config.string("OSFO_TEST_PHONE_NUMBER");
    const httpClient = yield* HttpClient.HttpClient;
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => postgres(databaseUrl, { max: 1, prepare: false })),
      (database) => Effect.promise(() => database.end({ timeout: 0 })),
    );
    const cleanupState = yield* Ref.make<CleanupState>({ cookie: "" });
    const request = Effect.fn("AccountDeletionEnvelopeTest.request")(function* (
      method: RequestMethod,
      path: string,
      body?: ComposedRequestBody,
    ) {
      const { cookie } = yield* Ref.get(cleanupState);
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
    const readTerminalDeletionState = Effect.fn(
      "AccountDeletionEnvelopeTest.readTerminalDeletionState",
    )(function* (userId: string) {
      const [row] = yield* Effect.promise(
        () => client`
        select
          exists(select 1 from account_deletion_actions where user_id = ${userId})
            as action_exists,
          exists(select 1 from sessions where user_id = ${userId})
            as auth_session_exists,
          exists(select 1 from deletion_cases where user_id = ${userId})
            as deletion_case_exists,
          exists(select 1 from users where id = ${userId}) as user_exists
      `,
      );
      return yield* Schema.decodeUnknownEffect(TerminalDeletionState)(row);
    });
    const cleanup = Effect.gen(function* () {
      const initialState = yield* Ref.get(cleanupState);
      if (initialState.cookie.length === 0) return false;
      const action =
        initialState.action === undefined
          ? yield* Effect.gen(function* () {
              const presented = yield* request("GET", "/v1/account/deletion-action");
              if (presented.status !== 200) {
                return yield* Effect.die(
                  new Error(`Cleanup could not present the deletion Action: ${presented.status}`),
                );
              }
              return yield* Schema.decodeUnknownEffect(AccountDeletionAction)(
                yield* presented.json,
              );
            })
          : initialState.action;
      yield* Ref.update(cleanupState, (state) => ({ ...state, action }));
      const { userId } = yield* Ref.get(cleanupState);
      if (userId === undefined) {
        return yield* Effect.die(new Error("Cleanup has no registered User identity"));
      }
      const accepted = yield* request("DELETE", "/v1/account", toExactRequest(action));
      if (
        accepted.status !== 200 &&
        !isTerminallyDeleted(yield* readTerminalDeletionState(userId))
      ) {
        return yield* Effect.die(
          new Error(`Cleanup could not retain account deletion: ${accepted.status}`),
        );
      }
      yield* accepted.text;
      const reconcile = Effect.gen(function* () {
        if (isTerminallyDeleted(yield* readTerminalDeletionState(userId))) return true;
        const scheduled = yield* request("GET", "/cdn-cgi/handler/scheduled");
        if (scheduled.status !== 200) {
          return yield* Effect.die(
            new Error(`Production account-deletion reconciliation failed: ${scheduled.status}`),
          );
        }
        yield* scheduled.text;
        return isTerminallyDeleted(yield* readTerminalDeletionState(userId));
      });
      const deleted = yield* Effect.repeat(reconcile, {
        schedule: Schedule.spaced(50),
        while: (terminal) => !terminal,
      }).pipe(Effect.timeout("60 seconds"));
      if (!deleted) {
        return yield* Effect.die(
          new Error("Account-deletion cleanup did not reach terminal absence"),
        );
      }
      return true;
    });

    yield* Effect.gen(function* () {
      const sent = yield* request("POST", "/auth/phone-number/send-otp", { phoneNumber });
      expect(sent.status).toBe(200);
      const verified = yield* request("POST", "/auth/phone-number/verify", {
        code: "424242",
        phoneNumber,
      });
      expect(verified.status).toBe(200);
      const cookie = verified.headers["set-cookie"]?.split(";")[0] ?? "";
      expect(cookie).not.toBe("");
      yield* Ref.update(cleanupState, (state) => ({ ...state, cookie }));

      const registered = yield* request("PUT", "/v1/registration", {
        helpAreas: [],
        locale: "en",
        preferredName: "Envelope Proof",
      });
      expect(registered.status).toBe(200);
      const { userId } = yield* Schema.decodeUnknownEffect(RegistrationResponse)(
        yield* registered.json,
      );
      yield* Ref.update(cleanupState, (state) => ({ ...state, userId }));
      const presented = yield* request("GET", "/v1/account/deletion-action");
      expect(presented.status).toBe(200);
      const action = yield* Schema.decodeUnknownEffect(AccountDeletionAction)(
        yield* presented.json,
      );
      yield* Ref.update(cleanupState, (state) => ({ ...state, action }));
      const exact = toExactRequest(action);
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
        yield* Schema.decodeUnknownEffect(AccountDeletionPending)(yield* accepted.json),
      ).toEqual({ status: "deletion-pending" });
    }).pipe(Effect.ensuring(cleanup.pipe(Effect.orDie)));
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
