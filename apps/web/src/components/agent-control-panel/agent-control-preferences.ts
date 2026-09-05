import { Data, Effect } from "effect";

import { isChannel, type Channel } from "./channel-model";

const storageKey = "osfo-agent-control-preferences";

/** Durable browser preferences for controls that do not require a backend mutation. */
export type AgentControlPreferences = {
  readonly primaryChannel: Channel;
};

/** Default control preferences for a new browser. */
export const defaultAgentControlPreferences: AgentControlPreferences = {
  primaryChannel: "whatsapp",
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
      try: () => storage.setItem(storageKey, `v2|${preferences.primaryChannel}`),
      catch: () => new AgentControlStorageUnavailable(),
    }).pipe(Effect.catchTag("AgentControlStorageUnavailable", () => Effect.void)),
  );

const readStoredPreferences = (stored: string | null): AgentControlPreferences => {
  if (stored === null) return defaultAgentControlPreferences;
  const parts = stored.split("|");
  const [version, storedChannel, receiveMessages] = parts;
  const current = version === "v2" && parts.length === 2;
  const legacy =
    version === "v1" &&
    parts.length === 3 &&
    (receiveMessages === "on" || receiveMessages === "off");
  if (!current && !legacy) return defaultAgentControlPreferences;
  const primaryChannel = storedChannel ?? null;
  if (!isChannel(primaryChannel)) return defaultAgentControlPreferences;
  return { primaryChannel };
};

class AgentControlStorageUnavailable extends Data.TaggedError("AgentControlStorageUnavailable") {}
