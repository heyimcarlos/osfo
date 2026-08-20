import { Effect } from "effect";

import type { UserId } from "../domain";
import type { DeletionCase } from "./deletion-case";
import type { UserSuspension } from "./user-suspension";

/* oxlint-disable eslint/no-underscore-dangle -- Domain facts use the _tag discriminator. */

/** Read whether current User Suspension and Deletion Case facts permit protected access. */
export const canAccess = (
  userSuspensions: Pick<UserSuspension.Interface, "inspect">,
  deletionCases: Pick<DeletionCase.Interface, "inspect">,
  userId: UserId,
) =>
  Effect.all([userSuspensions.inspect(userId), deletionCases.inspect(userId)]).pipe(
    Effect.map(
      ([user, deletionAccess]) =>
        user._tag === "ActiveUser" && deletionAccess._tag === "DeletionAccessAvailable",
    ),
  );

export * as AccountAccess from "./account-access";
