import { Api, CurrentUser, RegistrationUnavailable, type RegistrationResponse } from "@osfo/api";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { UserId } from "../domain";
import * as Registration from "../services/registration";

/** Implement the authenticated Registration contract. */
export const layer = Layer.unwrap(
  Effect.map(Registration.Service, (registration) =>
    HttpApiBuilder.group(Api, "registration", (handlers) =>
      handlers.handle("complete", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          return yield* registration.complete(UserId.make(currentUser.userId));
        }).pipe(Effect.map(toRegistrationResponse), Effect.mapError(toRegistrationUnavailable)),
      ),
    ),
  ),
);

const toRegistrationResponse = (
  registration: Registration.RegistrationCompleted,
): RegistrationResponse => registration;

const toRegistrationUnavailable = () =>
  new RegistrationUnavailable({
    message: "Registration is temporarily unavailable",
  });
