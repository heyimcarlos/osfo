import { Data, Effect } from "effect";

import { isChannel, type Channel } from "./channel-model";

const storageKey = "osfo-agent-control-preferences";

/** Durable browser preferences for controls that do not require a backend mutation. */
export type AgentControlPreferences = {
  readonly primaryChannel: Channel;
  readonly receiveMessages: boolean;
};

/** Default control preferences for a new browser. */
export const defaultAgentControlPreferences: AgentControlPreferences = {
  primaryChannel: "whatsapp",
  receiveMessages: true,
};

/** Load and parse durable Agent control preferences from browser storage. */
export const loadAgentControlPreferences = (
  storage: Pick<Storage, "getItem">,
): AgentControlPreferences =>
  readStoredPreferences(
    Effect.runSync(
      Effect.try({
        try: () => storage.getItem(storageKey),
        catch: () => new AgentControlStorageUnavailable(),
      }).pipe(Effect.catchTag("AgentControlStorageUnavailable", () => Effect.succeed(null))),
    ),
  );

/** Save one complete, schema-owned Agent control preference value. */
export const saveAgentControlPreferences = (
  storage: Pick<Storage, "setItem">,
  preferences: AgentControlPreferences,
) =>
  Effect.runSync(
    Effect.try({
      try: () =>
        storage.setItem(
          storageKey,
          `v1|${preferences.primaryChannel}|${preferences.receiveMessages ? "on" : "off"}`,
        ),
      catch: () => new AgentControlStorageUnavailable(),
    }).pipe(Effect.catchTag("AgentControlStorageUnavailable", () => Effect.void)),
  );

const readStoredPreferences = (stored: string | null): AgentControlPreferences => {
  if (stored === null) return defaultAgentControlPreferences;
  const parts = stored.split("|");
  if (parts.length !== 3) return defaultAgentControlPreferences;
  const [version, storedChannel, receiveMessages] = parts;
  if (version !== "v1" || (receiveMessages !== "on" && receiveMessages !== "off"))
    return defaultAgentControlPreferences;
  const primaryChannel = storedChannel ?? null;
  if (!isChannel(primaryChannel)) return defaultAgentControlPreferences;
  return { primaryChannel, receiveMessages: receiveMessages === "on" };
};

class AgentControlStorageUnavailable extends Data.TaggedError("AgentControlStorageUnavailable") {}
