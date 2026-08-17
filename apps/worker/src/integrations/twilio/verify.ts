import { Context, Effect, Layer, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as UserLifecycle from "../../services/user-lifecycle";

/* oxlint-disable eslint/no-underscore-dangle -- Effect tagged errors use the _tag discriminator. */

const TwilioVerificationStatus = Schema.Literals([
  "approved",
  "canceled",
  "deleted",
  "expired",
  "failed",
  "max_attempts_reached",
  "pending",
]);
const TwilioVerificationResponse = Schema.Struct({
  status: TwilioVerificationStatus,
});

/** Twilio Verify operations used in safe failures and telemetry. */
export const TwilioVerifyOperation = Schema.Literals(["sendCode", "verifyCode"]);

/** Twilio Verify operations used in safe failures and telemetry. */
export type TwilioVerifyOperation = typeof TwilioVerifyOperation.Type;

/** Safe failure when Twilio rejects or rate-limits a verification request. */
export class TwilioVerifyRejected extends Schema.TaggedError<TwilioVerifyRejected>()(
  "TwilioVerifyRejected",
  {
    message: Schema.String,
    operation: TwilioVerifyOperation,
  },
) {}

/** Safe failure when Twilio Verify cannot return a trusted response. */
export class TwilioVerifyUnavailable extends Schema.TaggedError<TwilioVerifyUnavailable>()(
  "TwilioVerifyUnavailable",
  {
    message: Schema.String,
    operation: TwilioVerifyOperation,
  },
) {}

/** Runtime configuration for the Twilio Verify HTTP adapter. */
export interface Options {
  readonly accountSid: Redacted.Redacted;
  readonly apiBaseURL?: string;
  readonly authToken: Redacted.Redacted;
  readonly serviceSid: string;
}

interface TwilioVerifyService {
  readonly sendCode: (
    phoneNumber: string,
  ) => Effect.Effect<void, TwilioVerifyRejected | TwilioVerifyUnavailable>;
  readonly verifyCode: (
    phoneNumber: string,
    code: Redacted.Redacted,
  ) => Effect.Effect<boolean, TwilioVerifyUnavailable>;
}

/** SMS verification authority backed by Twilio Verify. */
export class TwilioVerify extends Context.Service<TwilioVerify, TwilioVerifyService>()(
  "@osfo/worker/TwilioVerify",
) {}

/** Construct the Twilio Verify service with the current Effect HTTP client. */
export const make = (
  options: Options,
): Effect.Effect<TwilioVerify["Service"], never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const serviceURL = `${options.apiBaseURL ?? "https://verify.twilio.com"}/v2/Services/${options.serviceSid}`;

    const sendCode = Effect.fn("TwilioVerify.sendCode")(function* (phoneNumber: string) {
      const request = HttpClientRequest.post(`${serviceURL}/Verifications`).pipe(
        HttpClientRequest.basicAuth(options.accountSid, options.authToken),
        HttpClientRequest.bodyUrlParams({
          Channel: "sms",
          "RateLimits[phone_number]": phoneNumber,
          To: phoneNumber,
        }),
      );
      const response = yield* client.execute(request).pipe(
        Effect.mapError(
          () =>
            new TwilioVerifyUnavailable({
              message: "The SMS verification provider is unavailable",
              operation: "sendCode",
            }),
        ),
      );
      if (response.status >= 400 && response.status < 500) {
        return yield* new TwilioVerifyRejected({
          message: "The SMS verification request was rejected",
          operation: "sendCode",
        });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new TwilioVerifyUnavailable({
          message: "The SMS verification provider is unavailable",
          operation: "sendCode",
        });
      }
      const decoded = yield* HttpClientResponse.schemaBodyJson(TwilioVerificationResponse)(
        response,
      ).pipe(
        Effect.mapError(
          () =>
            new TwilioVerifyUnavailable({
              message: "The SMS verification provider returned an invalid response",
              operation: "sendCode",
            }),
        ),
      );
      if (decoded.status !== "pending") {
        return yield* new TwilioVerifyRejected({
          message: "The SMS verification request was rejected",
          operation: "sendCode",
        });
      }
      return undefined;
    });

    const verifyCode = Effect.fn("TwilioVerify.verifyCode")(function* (
      phoneNumber: string,
      code: Redacted.Redacted,
    ) {
      const request = HttpClientRequest.post(`${serviceURL}/VerificationCheck`).pipe(
        HttpClientRequest.basicAuth(options.accountSid, options.authToken),
        HttpClientRequest.bodyUrlParams({ Code: Redacted.value(code), To: phoneNumber }),
      );
      const response = yield* client.execute(request).pipe(
        Effect.mapError(
          () =>
            new TwilioVerifyUnavailable({
              message: "The SMS verification provider is unavailable",
              operation: "verifyCode",
            }),
        ),
      );
      if (response.status >= 400 && response.status < 500) {
        return false;
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new TwilioVerifyUnavailable({
          message: "The SMS verification provider is unavailable",
          operation: "verifyCode",
        });
      }
      const decoded = yield* HttpClientResponse.schemaBodyJson(TwilioVerificationResponse)(
        response,
      ).pipe(
        Effect.mapError(
          () =>
            new TwilioVerifyUnavailable({
              message: "The SMS verification provider returned an invalid response",
              operation: "verifyCode",
            }),
        ),
      );
      return decoded.status === "approved";
    });

    return TwilioVerify.of({ sendCode, verifyCode });
  });

/** Twilio Verify Layer that preserves the HTTP client requirement. */
export const layerWithoutDependencies = (options: Options) =>
  Layer.effect(TwilioVerify, make(options));

/** Production Twilio Verify Layer backed by the Worker Fetch HTTP client. */
export const layer = (options: Options) =>
  layerWithoutDependencies(options).pipe(Layer.provide(FetchHttpClient.layer));

/** Adapt Twilio Verify to the provider-neutral User lifecycle phone verification port. */
export const makeUserLifecyclePhoneVerification = Effect.map(TwilioVerify, (twilio) =>
  UserLifecycle.PhoneVerification.of({
    sendCode: (phoneNumber) =>
      twilio
        .sendCode(phoneNumber)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "TwilioVerifyRejected"
              ? new UserLifecycle.PhoneVerificationRequestRejected({ message: error.message })
              : new UserLifecycle.PhoneVerificationUnavailable({ message: error.message }),
          ),
        ),
    verifyCode: (phoneNumber, code) =>
      twilio
        .verifyCode(phoneNumber, code)
        .pipe(
          Effect.mapError(
            (error) => new UserLifecycle.PhoneVerificationUnavailable({ message: error.message }),
          ),
        ),
  }),
);

/** User lifecycle phone verification Layer backed by an existing Twilio Verify capability. */
export const userLifecycleLayerWithoutDependencies = Layer.effect(
  UserLifecycle.PhoneVerification,
  makeUserLifecyclePhoneVerification,
);
