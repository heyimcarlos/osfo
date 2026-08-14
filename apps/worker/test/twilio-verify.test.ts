import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import {
  HttpBody,
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as TwilioVerify from "../src/integrations/twilio/verify";

const options = {
  accountSid: Redacted.make(`AC${"1".repeat(32)}`),
  apiBaseURL: "https://twilio.test",
  authToken: Redacted.make("test-only-token"),
  serviceSid: `VA${"2".repeat(32)}`,
};

describe("Twilio Verify adapter", () => {
  it.effect("sends an SMS with the phone rate-limit key", () =>
    Effect.gen(function* () {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const client = recordingClient(requests, () => jsonResponse({ status: "pending" }));
      const service = yield* TwilioVerify.make(options).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      yield* service.sendCode("+14165550101");

      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe(
        `https://twilio.test/v2/Services/${options.serviceSid}/Verifications`,
      );
      expect(bodyParams(requests[0])).toEqual({
        Channel: "sms",
        "RateLimits[phone_number]": "+14165550101",
        To: "+14165550101",
      });
      expect(requests[0]?.headers.authorization).toMatch(/^Basic /);
    }),
  );

  it.effect("checks the code with Twilio as the OTP authority", () =>
    Effect.gen(function* () {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const client = recordingClient(requests, () => jsonResponse({ status: "approved" }));
      const service = yield* TwilioVerify.make(options).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      const approved = yield* service.verifyCode("+14165550102", "123456");

      expect(approved).toBe(true);
      expect(requests[0]?.url).toBe(
        `https://twilio.test/v2/Services/${options.serviceSid}/VerificationCheck`,
      );
      expect(bodyParams(requests[0])).toEqual({
        Code: "123456",
        To: "+14165550102",
      });
    }),
  );

  it.effect("returns false for a provider-rejected verification", () =>
    Effect.gen(function* () {
      const client = recordingClient([], () => new Response(null, { status: 404 }));
      const service = yield* TwilioVerify.make(options).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(yield* service.verifyCode("+14165550103", "000000")).toBe(false);
    }),
  );

  it.effect("uses a typed safe failure for an invalid provider response", () =>
    Effect.gen(function* () {
      const client = recordingClient([], () => jsonResponse({ unexpected: true }));
      const service = yield* TwilioVerify.make(options).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      const failure = yield* Effect.flip(service.sendCode("+14165550104"));

      expect(failure).toMatchObject({
        _tag: "TwilioVerifyUnavailable",
        message: "The SMS verification provider returned an invalid response",
        operation: "sendCode",
      });
      expect(String(failure)).not.toContain("test-only-token");
    }),
  );
});

const recordingClient = (
  requests: Array<HttpClientRequest.HttpClientRequest>,
  respond: () => Response,
) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return HttpClientResponse.fromWeb(request, respond());
    }),
  );

type TwilioResponseFixture = Readonly<Record<string, string | boolean>>;
const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const jsonResponse = (body: TwilioResponseFixture) =>
  new Response(encodeJsonText(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });

const bodyParams = (request: HttpClientRequest.HttpClientRequest | undefined) => {
  if (request?.body instanceof HttpBody.Uint8Array) {
    return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(request.body.body)));
  }
  return undefined;
};
