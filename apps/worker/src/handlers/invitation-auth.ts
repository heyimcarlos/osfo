import { Effect, Redacted, Schema } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import * as Auth from "../auth";
import * as AccountAccess from "../composition/account-access";
import { handleAuthRequest } from "../cors";
import { PhoneNumber } from "../domain/phone-account";
import * as Onboarding from "../services/onboarding";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Fetch control flow and Effect tags require these forms. */

const InvitationRequest = Schema.Struct({
  phoneNumber: Schema.optionalKey(PhoneNumber),
  token: Onboarding.RegistrationToken,
});
const InvitationVerificationRequest = Schema.Struct({
  code: Schema.String.check(
    Schema.makeFilter((value) => /^\d{6}$/u.test(value) || "must be a six-digit code"),
  ),
  phoneNumber: Schema.optionalKey(PhoneNumber),
  token: Onboarding.RegistrationToken,
});

/** Options for invitation-scoped Better Auth proxy routes. */
export interface Options {
  readonly config: Auth.AuthRouteConfig;
}

/** Keep the invited phone number server-side while reusing Better Auth SMS policy. */
export const layer = (options: Options) => {
  const handler = Effect.gen(function* () {
    const canAccess = yield* AccountAccess.make;
    const auth = yield* Auth.make(options.config, canAccess);
    const onboarding = yield* Onboarding.Service;

    return yield* HttpEffect.fromWebHandler((request) =>
      handleAuthRequest(
        request,
        () => proxyInvitationRequest(request, auth.handler, onboarding),
        options.config.trustedOrigins,
      ),
    );
  });

  return HttpRouter.add("*", "/auth/onboarding/*", handler);
};

const proxyInvitationRequest = async (
  request: Request,
  authHandler: (request: Request) => Promise<Response>,
  onboarding: Onboarding.Interface,
): Promise<Response> => {
  const action = new URL(request.url).pathname.split("/").at(-1);
  if (request.method !== "POST" || (action !== "send-otp" && action !== "verify")) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  let body: typeof InvitationRequest.Type | typeof InvitationVerificationRequest.Type;
  try {
    const unknownBody: unknown = await request.json();
    body =
      action === "send-otp"
        ? Schema.decodeUnknownSync(InvitationRequest)(unknownBody)
        : Schema.decodeUnknownSync(InvitationVerificationRequest)(unknownBody);
  } catch {
    return jsonResponse({ error: "The invitation verification request is invalid." }, 400);
  }
  const targetResult = await Effect.runPromise(
    onboarding.phoneVerificationTarget(Redacted.make(body.token)).pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: "Failure" as const, error }),
        onSuccess: (target) => ({ _tag: "Success" as const, target }),
      }),
    ),
  );
  if (targetResult._tag === "Failure") {
    return targetResult.error._tag === "RegistrationInvitationUnavailable"
      ? jsonResponse(
          { error: "This registration link is no longer available. Request a new link." },
          410,
        )
      : jsonResponse({ error: "Phone Verification is temporarily unavailable." }, 503);
  }

  try {
    const phoneNumber =
      targetResult.target._tag === "LockedPhone"
        ? Redacted.value(targetResult.target.phoneNumber)
        : body.phoneNumber;
    if (phoneNumber === undefined) {
      return jsonResponse({ error: "Enter a valid phone number." }, 400);
    }
    const target = new URL(
      action === "send-otp" ? "/auth/phone-number/send-otp" : "/auth/phone-number/verify",
      request.url,
    );
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    const proxiedBody =
      action === "send-otp"
        ? { phoneNumber }
        : { code: "code" in body ? body.code : "", phoneNumber };
    return await authHandler(
      new Request(target, {
        body: JSON.stringify(proxiedBody),
        headers,
        method: "POST",
      }),
    );
  } catch {
    return jsonResponse({ error: "Phone Verification is temporarily unavailable." }, 503);
  }
};

const jsonResponse = (body: { readonly error: string }, status: number) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
