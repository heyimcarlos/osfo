/** Agents 0.20 persists one-time schedule instants at whole-second precision. */
export const reminderSchedulerEpochSecond = (nominalDueAt: Date) =>
  Math.ceil(nominalDueAt.getTime() / 1_000);

/** Never let scheduler precision invoke a Reminder before its nominal due instant. */
export const reminderSchedulerDate = (nominalDueAt: Date) =>
  // oxlint-disable-next-line effecttsgo/global-date -- The installed Agents scheduler boundary requires a native Date.
  new Date(reminderSchedulerEpochSecond(nominalDueAt) * 1_000);
