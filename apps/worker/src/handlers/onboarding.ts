import {
  Api,
  ChannelBindingNeedsSupport,
  CurrentUser,
  InvitationUnavailable,
  OnboardingUnavailable,
  PhoneVerificationRequired,
} from "@osfo/api";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { UserId } from "../domain";
import * as Onboarding from "../services/onboarding";

/* oxlint-disable eslint/no-underscore-dangle -- Effect errors use the standard _tag discriminator. */

/** Implement public invitation inspection and authenticated onboarding completion. */
export const layer = Layer.unwrap(
  Effect.map(Onboarding.Service, (onboarding) =>
    HttpApiBuilder.group(Api, "onboarding", (handlers) =>
      handlers
        .handle("inspectInvitation", ({ params }) =>
          Schema.decodeEffect(Onboarding.RegistrationToken)(params.token).pipe(
            Effect.flatMap((token) => onboarding.inspectInvitation(Redacted.make(token))),
            Effect.mapError(
              () =>
                new OnboardingUnavailable({
                  message: "The registration link cannot be checked right now.",
                }),
            ),
          ),
        )
        .handle("complete", ({ payload }) =>
          Effect.gen(function* () {
            const currentUser = yield* CurrentUser;
            const invitationToken =
              payload.invitationToken === null
                ? null
                : Redacted.make(
                    yield* Schema.decodeEffect(Onboarding.RegistrationToken)(
                      payload.invitationToken,
                    ),
                  );
            return yield* onboarding.complete({
              existingProfileChoice: payload.existingProfileChoice,
              invitationToken,
              profile: {
                helpAreas: payload.helpAreas,
                locale: payload.locale,
                preferredName: payload.preferredName,
              },
              userId: UserId.make(currentUser.userId),
            });
          }).pipe(Effect.mapError(toPublicError)),
        )
        .handle("startChannelEnrollment", ({ payload }) =>
          Effect.gen(function* () {
            const currentUser = yield* CurrentUser;
            return yield* onboarding.startChannelEnrollment({
              provider: payload.provider,
              userId: UserId.make(currentUser.userId),
            });
          }).pipe(Effect.mapError(toEnrollmentPublicError)),
        ),
    ),
  ),
);

const toPublicError = (error: { readonly _tag: string }) => {
  if (error._tag === "RegistrationInvitationUnavailable") {
    return new InvitationUnavailable({
      message: "This registration link is no longer available. Request a new link.",
    });
  }
  if (error._tag === "ChannelBindingConflict") {
    return new ChannelBindingNeedsSupport({
      message: "This channel identity needs manual support before it can be connected.",
    });
  }
  if (error._tag === "OnboardingPhoneVerificationRequired") {
    return new PhoneVerificationRequired({
      message: "Verify your phone before completing setup.",
    });
  }
  return new OnboardingUnavailable({
    message: "Onboarding is temporarily unavailable. Please try again.",
  });
};

const toEnrollmentPublicError = (error: { readonly _tag: string }) =>
  error._tag === "OnboardingPhoneVerificationRequired"
    ? new PhoneVerificationRequired({
        message: "Complete phone verification before connecting a channel.",
      })
    : new OnboardingUnavailable({
        message: "The channel connection is temporarily unavailable. Please try again.",
      });
