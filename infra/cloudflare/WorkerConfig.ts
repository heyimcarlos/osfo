import { Config, Effect, Redacted, Schema, SchemaIssue } from "effect";

const blankComposioApiKeyError = new Config.ConfigError(
  new Schema.SchemaError(
    new SchemaIssue.InvalidValue({ message: "COMPOSIO_API_KEY must not be blank" }),
  ),
);

const requiredComposioApiKey = Config.redacted("COMPOSIO_API_KEY").pipe(
  Config.mapOrFail((apiKey) =>
    Redacted.value(apiKey).trim().length === 0
      ? Effect.fail(blankComposioApiKeyError)
      : Effect.succeed(apiKey),
  ),
);

/** Read the Composio credential required by production Worker deployments. */
export const composioApiKeyConfig = (stage: string) =>
  stage === "production"
    ? requiredComposioApiKey
    : Config.redacted("COMPOSIO_API_KEY").pipe(Config.withDefault(Redacted.make("")));
