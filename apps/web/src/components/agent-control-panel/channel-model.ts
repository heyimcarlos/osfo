import { MessageCircle, Send, type LucideIcon } from "lucide-react";

/** Display metadata for each supported messaging channel. */
export const channels = [
  { color: "#28b66f", icon: MessageCircle, id: "whatsapp", label: "WhatsApp" },
  { color: "#2f8fe8", icon: Send, id: "telegram", label: "Telegram" },
] as const satisfies ReadonlyArray<{
  readonly color: string;
  readonly icon: LucideIcon;
  readonly id: string;
  readonly label: string;
}>;

/** Messaging channel identifier inferred from the owned channel catalog. */
export type Channel = (typeof channels)[number]["id"];

/** Refine a stored string to one supported messaging channel. */
export const isChannel = (value: string | null): value is Channel =>
  value === "telegram" || value === "whatsapp";
