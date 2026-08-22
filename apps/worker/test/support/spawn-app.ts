/* oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch -- Worker journeys intentionally exercise raw HTTP and provider boundaries. */
import { exports } from "cloudflare:workers";
import { Schema } from "effect";
import { inject } from "vitest";

const RegistrationResponse = Schema.Struct({
  agentId: Schema.String,
  completedAt: Schema.String,
  userId: Schema.String,
});

const TwilioLedger = Schema.Array(
  Schema.Struct({
    code: Schema.NullOr(Schema.String),
    path: Schema.String,
    to: Schema.NullOr(Schema.String),
  }),
);

const StripeLedger = Schema.Array(
  Schema.Struct({
    idempotencyKey: Schema.NullOr(Schema.String),
    parameters: Schema.Record(Schema.String, Schema.String),
    path: Schema.String,
  }),
);

const StoredRegistration = Schema.Struct({
  agent_id: Schema.String,
  allowance_plan: Schema.String,
  billing_plan: Schema.String,
  help_areas: Schema.Array(Schema.String),
  locale: Schema.String,
  phone_number_verified: Schema.Boolean,
  preferred_name: Schema.NullOr(Schema.String),
  registration_completed_at: Schema.DateFromString,
});

const StoredBillingCheckout = Schema.Struct({
  billing_checkout_session_id: Schema.String,
  billing_customer_id: Schema.String,
  state: Schema.String,
  stripe_checkout_session_id: Schema.String,
  stripe_customer_id: Schema.String,
  stripe_price_id: Schema.String,
  stripe_product_id: Schema.String,
  target_plan: Schema.String,
});

const BillingRedirect = Schema.Struct({ url: Schema.String });

interface PhoneOtpRequest {
  readonly phoneNumber: string;
}

interface PhoneOtpVerificationRequest extends PhoneOtpRequest {
  readonly code: string;
}

interface RegistrationProfile {
  readonly helpAreas: ReadonlyArray<string>;
  readonly locale: "en" | "es";
  readonly preferredName: string | null;
}

type JsonRequestBody = PhoneOtpRequest | PhoneOtpVerificationRequest | RegistrationProfile;

/** Create one stateful HTTP client and observation surface for a Worker journey. */
export const spawnApp = async () => {
  const context = inject("osfoJourney");
  const reset = await fetch(`${context.providerOrigin}/_test/reset`, { method: "POST" });
  if (!reset.ok) throw new Error(`Provider emulator reset failed with ${reset.status}`);
  let cookie = "";

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("cf-connecting-ip", "127.0.0.1");
    headers.set("origin", "https://osfo.test");
    if (cookie.length > 0) headers.set("cookie", cookie);
    return exports.default.fetch(new Request(`https://osfo.test${path}`, { ...init, headers }));
  };

  return {
    fetch: request,
    auth: {
      session: () => request("/auth/get-session"),
      sendPhoneOtp: (phoneNumber: string) =>
        jsonRequest(request, "/auth/phone-number/send-otp", "POST", { phoneNumber }),
      verifyPhoneOtp: async (phoneNumber: string, code: string) => {
        const response = await jsonRequest(request, "/auth/phone-number/verify", "POST", {
          code,
          phoneNumber,
        });
        cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
        return response;
      },
    },
    database: {
      billingCheckout: async (userId: string) => {
        const response = await fetch(`${context.databaseObserverOrigin}/billing-checkout`, {
          body: JSON.stringify({ userId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return Schema.decodeUnknownPromise(Schema.NullOr(StoredBillingCheckout))(
          await response.json(),
        );
      },
      registration: async (userId: string) => {
        const response = await fetch(`${context.databaseObserverOrigin}/registration`, {
          body: JSON.stringify({ userId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return Schema.decodeUnknownPromise(Schema.NullOr(StoredRegistration))(
          await response.json(),
        );
      },
    },
    billing: {
      checkout: async () => {
        const response = await jsonRequest(request, "/v1/billing/checkout", "POST");
        return {
          body: response.ok
            ? await Schema.decodeUnknownPromise(BillingRedirect)(await response.json())
            : undefined,
          response,
        };
      },
    },
    registration: {
      complete: async (profile: RegistrationProfile) => {
        const response = await jsonRequest(request, "/v1/registration", "PUT", profile);
        return {
          body: response.ok
            ? await Schema.decodeUnknownPromise(RegistrationResponse)(await response.json())
            : undefined,
          response,
        };
      },
    },
    twilio: {
      ledger: async () => {
        const response = await fetch(`${context.providerOrigin}/_test/twilio/ledger`);
        return Schema.decodeUnknownPromise(TwilioLedger)(await response.json());
      },
    },
    stripe: {
      ledger: async () => {
        const response = await fetch(`${context.providerOrigin}/_test/stripe/ledger`);
        return Schema.decodeUnknownPromise(StripeLedger)(await response.json());
      },
    },
    dispose: () => {
      cookie = "";
      return Promise.resolve();
    },
  };
};

const jsonRequest = (
  request: (path: string, init?: RequestInit) => Promise<Response>,
  path: string,
  method: string,
  body?: JsonRequestBody,
): Promise<Response> =>
  request(path, {
    body: JSON.stringify(body ?? {}),
    headers: { "content-type": "application/json" },
    method,
  });
