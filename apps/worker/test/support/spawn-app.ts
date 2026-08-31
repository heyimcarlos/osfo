/* oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch -- Worker journeys intentionally exercise raw HTTP and provider boundaries. */
import { exports } from "cloudflare:workers";
import {
  AccountDeletionAction,
  GmailSendApprovalDecisionAccepted,
  GmailSends,
  IntegrationConnectRedirect,
} from "@osfo/api";
import type { AccountDeletionActionPresentation } from "@osfo/api";
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
const IntegrationLedger = Schema.Array(
  Schema.Struct({
    input: Schema.Record(Schema.String, Schema.Unknown),
    providerTool: Schema.String,
    userId: Schema.String,
  }),
);
const IntegrationControl = Schema.Struct({ swapAfterInspections: Schema.NullOr(Schema.Finite) });
const GmailSendUsage = Schema.Array(
  Schema.Struct({ basis: Schema.String, quantity: Schema.String, source_id: Schema.String }),
);
type PresentedAccountDeletionAction = AccountDeletionActionPresentation & {
  readonly presentationVersion: string;
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
  allowance_ends_at: Schema.DateFromString,
  allowance_period_id: Schema.String,
  allowance_plan: Schema.String,
  allowance_starts_at: Schema.DateFromString,
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
  | { readonly toolkit: "gmail" }
  | {
      readonly decision: "approve" | "reject";
      readonly presentationId: string;
      readonly reason?: string;
    }
  | { readonly userId: string }
  | {
      readonly approval: {
        readonly decision: "approved";
        readonly presentation: AccountDeletionActionPresentation;
      };
      readonly confirmation: "delete-my-account";
      readonly presentationVersion: string;
      readonly replayToken: string;
    };

interface MintVerifiedUserOptions {
  readonly phoneNumber?: string;
  readonly profile?: RegistrationProfile;
}

let nextPhoneNumber = 1_000_000;
let nextClientAddress = 1;

/** Create one stateful HTTP client and observation surface for a Worker journey. */
export const spawnApp = async () => {
  const context = inject("osfoJourney");
  const clientAddress = `127.0.${Math.floor(nextClientAddress / 250)}.${(nextClientAddress % 250) + 1}`;
  nextClientAddress += 1;
  const reset = await fetch(`${context.providerOrigin}/_test/reset`, { method: "POST" });
  if (!reset.ok) throw new Error(`Provider emulator reset failed with ${reset.status}`);
  let cookie = "";

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("cf-connecting-ip", clientAddress);
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
      delete: (action: PresentedAccountDeletionAction) =>
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
          presentationVersion: action.presentationVersion,
          replayToken: action.replayToken,
        }),
      present: async () => {
        const response = await request("/v1/account/deletion-action");
        return {
          body: response.ok
            ? await Schema.decodeUnknownPromise(AccountDeletionAction)(await response.json()).then(
                ({ presentation, presentationVersion, replayToken }) => ({
                  ...presentation,
                  presentationVersion,
                  replayToken,
                }),
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
      versionAccountDeletionAction: async (
        userId: string,
        actionId: string,
        presentationVersion: string,
      ) => {
        const response = await fetch(
          `${context.databaseObserverOrigin}/version-account-deletion-action`,
          {
            body: JSON.stringify({ actionId, presentationVersion, userId }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        await requireSuccessfulResponse(response, "Version account deletion Action");
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
      gmailSendUsage: async (userId: string) => {
        const response = await fetch(`${context.databaseObserverOrigin}/gmail-send-usage`, {
          body: JSON.stringify({ userId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return Schema.decodeUnknownPromise(GmailSendUsage)(await response.json());
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
    integrations: {
      connectionControl: async () => {
        const response = await fetch(`${context.providerOrigin}/_test/integrations/control`);
        return Schema.decodeUnknownPromise(IntegrationControl)(await response.json());
      },
      connectGmail: async () => {
        const response = await jsonRequest(request, "/v1/integrations/connect", "POST", {
          toolkit: "gmail",
        });
        return {
          body: response.ok
            ? await Schema.decodeUnknownPromise(IntegrationConnectRedirect)(await response.json())
            : undefined,
          response,
        };
      },
      decideGmailSend: async (decision: "approve" | "reject", presentationId: string) => {
        const response = await jsonRequest(
          request,
          "/v1/integrations/gmail-sends/approval",
          "POST",
          { decision, presentationId },
        );
        return {
          body: response.ok
            ? await Schema.decodeUnknownPromise(GmailSendApprovalDecisionAccepted)(
                await response.json(),
              )
            : undefined,
          response,
        };
      },
      disconnectGmail: () =>
        jsonRequest(request, "/v1/integrations/disconnect", "POST", { toolkit: "gmail" }),
      gmailSends: async () => {
        const response = await request("/v1/integrations/gmail-sends");
        return {
          body: response.ok
            ? await Schema.decodeUnknownPromise(GmailSends)(await response.json())
            : undefined,
          response,
        };
      },
      ledger: async () => {
        const response = await fetch(`${context.providerOrigin}/_test/integrations/ledger`);
        return Schema.decodeUnknownPromise(IntegrationLedger)(await response.json());
      },
      nextGmailAction: async (actionId: string) => {
        const response = await fetch(
          `${context.providerOrigin}/_test/integrations/next-gmail-action?actionId=${encodeURIComponent(actionId)}`,
          { method: "POST" },
        );
        await requireSuccessfulResponse(response, "Configure immediate Gmail Action identity");
      },
      swapGmailConnectionAfterInspections: async (afterInspections: number) => {
        const response = await fetch(
          `${context.providerOrigin}/_test/integrations/swap-connection?afterInspections=${afterInspections}`,
          { method: "POST" },
        );
        await requireSuccessfulResponse(response, "Schedule Gmail connection replacement");
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
