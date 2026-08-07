import { randomUUID } from "node:crypto";
import { Config } from "effect";

export const makeRelayIdConfig = (
  fallbackId = `outbox-relay-${randomUUID()}`,
): Config.Config<string> =>
  Config.nonEmptyString("OSFO_RELAY_ID").pipe(
    Config.orElse(() => Config.nonEmptyString("HOSTNAME").pipe(Config.withDefault(fallbackId))),
  );
