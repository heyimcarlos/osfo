/** Present a User without exposing Better Auth's internal placeholder email. */
export const presentUserLabel = (user: {
  readonly name: string;
  readonly phoneNumber?: string | null | undefined;
}) => {
  const name = user.name.trim();
  if (name.length > 0 && name !== "Osfo User" && !name.endsWith(".invalid")) return name;
  if (user.phoneNumber === undefined || user.phoneNumber === null) return "Osfo User";
  const visible = user.phoneNumber.slice(-4);
  return `${"•".repeat(Math.max(4, user.phoneNumber.length - visible.length))}${visible}`;
};
