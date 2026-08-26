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

const SupermemoryLedger = Schema.Array(
  Schema.Struct({ method: Schema.String, path: Schema.String }),
);
const SupermemoryContainers = Schema.Array(Schema.String);
const SupermemorySeedResponse = Schema.Struct({ containerTag: Schema.String });
const AccountDeletionPresentation = Schema.Struct({
  actionId: Schema.String,
  confirmation: Schema.Literal("delete-my-account"),
  consequence: Schema.Literal("Permanently delete this account and all of its data."),
  operation: Schema.Literal("account.delete"),
  title: Schema.Literal("Delete Account"),
});
type AccountDeletionPresentation = typeof AccountDeletionPresentation.Type;
const AccountDeletionAction = Schema.Struct({
  presentation: AccountDeletionPresentation,
  replayToken: Schema.String,
});
type AccountDeletionAction = AccountDeletionPresentation & {
  readonly replayToken: string;
};

const StoredAccountDeletion = Schema.Struct({
  agent_exists: Schema.Boolean,
  auth_session_exists: Schema.Boolean,
  deletion_case_exists: Schema.Boolean,
  user_exists: Schema.Boolean,
});

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

type JsonRequestBody =
  | PhoneOtpRequest
  | PhoneOtpVerificationRequest
  | RegistrationProfile
  | { readonly userId: string }
  | {
      readonly approval: {
        readonly decision: "approved";
        readonly presentation: AccountDeletionPresentation;
      };
      readonly confirmation: "delete-my-account";
      readonly replayToken: string;
    };

interface MintVerifiedUserOptions {
  readonly phoneNumber?: string;
  readonly profile?: RegistrationProfile;
}

let nextPhoneNumber = 1_000_000;

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

  const sendPhoneOtp = (phoneNumber: string) =>
    jsonRequest(request, "/auth/phone-number/send-otp", "POST", { phoneNumber });
  const verifyPhoneOtp = async (phoneNumber: string, code: string) => {
    const response = await jsonRequest(request, "/auth/phone-number/verify", "POST", {
      code,
      phoneNumber,
    });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    return response;
  };
  const completeRegistration = async (profile: RegistrationProfile) => {
    const response = await jsonRequest(request, "/v1/registration", "PUT", profile);
    return {
      body: response.ok
        ? await Schema.decodeUnknownPromise(RegistrationResponse)(await response.json())
        : undefined,
      response,
    };
  };
  const mintVerifiedUser = async (options: MintVerifiedUserOptions = {}) => {
    const phoneNumber = options.phoneNumber ?? syntheticPhoneNumber();
    const sent = await sendPhoneOtp(phoneNumber);
    await requireSuccessfulResponse(sent, "Send phone OTP");
    const verified = await verifyPhoneOtp(phoneNumber, "424242");
    await requireSuccessfulResponse(verified, "Verify phone OTP");
    const completed = await completeRegistration(
      options.profile ?? { helpAreas: [], locale: "en", preferredName: null },
    );
    await requireSuccessfulResponse(completed.response, "Complete registration");
    if (completed.body === undefined) {
      throw new Error("Complete registration returned no User identity");
    }
    return { ...completed.body, phoneNumber };
  };

  return {
    fetch: request,
    account: {
      delete: (action: AccountDeletionAction) =>
        jsonRequest(request, "/v1/account", "DELETE", {
          approval: {
            decision: "approved",
            presentation: {
              actionId: action.actionId,
              confirmation: action.confirmation,
              consequence: action.consequence,
              operation: action.operation,
              title: action.title,
            },
          },
          confirmation: "delete-my-account",
          replayToken: action.replayToken,
        }),
      present: async () => {
        const response = await request("/v1/account/deletion-action");
        return {
          body: response.ok
            ? await Schema.decodeUnknownPromise(AccountDeletionAction)(await response.json()).then(
                ({ presentation, replayToken }) => ({ ...presentation, replayToken }),
              )
            : undefined,
          response,
        };
      },
    },
    auth: {
      clearCookie: () => {
        cookie = "";
      },
      mintVerifiedUser,
      session: () => request("/auth/get-session"),
      sendPhoneOtp,
      verifyPhoneOtp,
    },
    database: {
      expireAccountDeletionAction: async (userId: string, actionId: string) => {
        const response = await fetch(
          `${context.databaseObserverOrigin}/expire-account-deletion-action`,
          {
            body: JSON.stringify({ actionId, userId }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        await requireSuccessfulResponse(response, "Expire account deletion Action");
      },
      accountDeletion: async (userId: string) => {
        const response = await fetch(`${context.databaseObserverOrigin}/account-deletion`, {
          body: JSON.stringify({ userId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return Schema.decodeUnknownPromise(Schema.NullOr(StoredAccountDeletion))(
          await response.json(),
        );
      },
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
      complete: completeRegistration,
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
    supermemory: {
      containers: async () => {
        const response = await fetch(`${context.providerOrigin}/_test/supermemory/containers`);
        return Schema.decodeUnknownPromise(SupermemoryContainers)(await response.json());
      },
      ledger: async () => {
        const response = await fetch(`${context.providerOrigin}/_test/supermemory/ledger`);
        return Schema.decodeUnknownPromise(SupermemoryLedger)(await response.json());
      },
      failDeletes: async (count: number) => {
        const response = await fetch(
          `${context.providerOrigin}/_test/supermemory/delete-failures`,
          {
            body: JSON.stringify({ count }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        await requireSuccessfulResponse(response, "Configure Supermemory deletion failures");
      },
      seedUser: async (userId: string) => {
        const response = await fetch(`${context.providerOrigin}/_test/supermemory/seed`, {
          body: JSON.stringify({ userId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        await requireSuccessfulResponse(response, "Seed Supermemory User container");
        return Schema.decodeUnknownPromise(SupermemorySeedResponse)(await response.json());
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

const syntheticPhoneNumber = (): string => {
  const phoneNumber = `+1555${String(nextPhoneNumber).padStart(7, "0")}`;
  nextPhoneNumber += 1;
  return phoneNumber;
};

const requireSuccessfulResponse = async (response: Response, operation: string): Promise<void> => {
  if (response.ok) return;
  throw new Error(`${operation} failed with HTTP ${response.status}: ${await response.text()}`);
};
