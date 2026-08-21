import {
  Api,
  CurrentUser,
  RegistrationPhoneVerificationRequired,
  RegistrationUnavailable,
  type RegistrationResponse,
} from "@osfo/api";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { UserId } from "../domain";
import { Registration } from "../services/registration";

/* oxlint-disable eslint/no-underscore-dangle -- Effect failures use tagged values. */

/** Implement the authenticated Registration contract. */
export const layer = Layer.unwrap(
  Effect.map(Registration.Service, (registration) =>
    HttpApiBuilder.group(Api, "registration", (handlers) =>
      handlers.handle("complete", ({ payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          return yield* registration.complete({
            profile: payload,
            userId: UserId.make(currentUser.userId),
          });
        }).pipe(Effect.map(toRegistrationResponse), Effect.mapError(toRegistrationUnavailable)),
      ),
    ),
  ),
);

const toRegistrationResponse = (
  registration: Registration.RegistrationCompleted,
): RegistrationResponse => registration;

const toRegistrationUnavailable = (
  error: Registration.RegistrationError | Registration.RegistrationAgentUnavailable,
) =>
  error._tag === "RegistrationPhoneVerificationRequired"
    ? new RegistrationPhoneVerificationRequired({ message: error.message })
    : new RegistrationUnavailable({
        message: "Registration is temporarily unavailable",
      });

export * as RegistrationHandlers from "./registration";
