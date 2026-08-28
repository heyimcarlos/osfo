import { Effect } from "effect";

import type { UserId } from "../../domain";
import type { Interface as PersonalSkillAuthority } from "./personal-skill-authority";
import type { ReminderAuthority } from "./reminders";

/** Delete scheduled Reminder authority before erasing the remaining Agent-owned User data. */
export const deleteAgentOwnedUserData = (
  reminders: Pick<ReminderAuthority, "deleteUser">,
  personalSkills: Pick<PersonalSkillAuthority, "deleteUserData">,
  userId: UserId,
) =>
  Effect.gen(function* () {
    yield* reminders.deleteUser(userId);
    yield* personalSkills.deleteUserData(userId);
  });
