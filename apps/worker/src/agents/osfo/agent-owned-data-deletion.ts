import { Effect } from "effect";

import type { UserId } from "../../domain";
import type { Interface as PersonalSkillAuthority } from "./personal-skill-authority";
import type { ReminderAuthority } from "./reminders";
import type { ImmediateGmailSend } from "./immediate-gmail-send";

/** Delete scheduled Reminder authority before erasing the remaining Agent-owned User data. */
export const deleteAgentOwnedUserData = (
  reminders: Pick<ReminderAuthority, "deleteUser">,
  personalSkills: Pick<PersonalSkillAuthority, "deleteUserData">,
  immediateGmailSends: Pick<ImmediateGmailSend.Interface, "deleteUser">,
  userId: UserId,
) =>
  Effect.gen(function* () {
    yield* reminders.deleteUser(userId);
    yield* personalSkills.deleteUserData(userId);
    yield* immediateGmailSends.deleteUser(userId);
  });
