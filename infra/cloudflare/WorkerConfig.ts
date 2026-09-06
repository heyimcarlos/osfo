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

/** Only local development forwards an explicitly provisioned browser binding. */
export const browserHostBindings = (stage: string) => ({
  BROWSER_HOST_ALLOWED_ORIGINS:
    stage === "development"
      ? Config.string("BROWSER_HOST_ALLOWED_ORIGINS").pipe(Config.withDefault("[]"))
      : Config.succeed("[]"),
  BROWSER_HOST_ENDPOINT:
    stage === "development"
      ? Config.string("BROWSER_HOST_ENDPOINT").pipe(Config.withDefault(""))
      : Config.succeed(""),
  BROWSER_HOST_OWNER_USER_ID:
    stage === "development"
      ? Config.string("BROWSER_HOST_OWNER_USER_ID").pipe(Config.withDefault(""))
      : Config.succeed(""),
  BROWSER_HOST_SESSION_ID:
    stage === "development"
      ? Config.string("BROWSER_HOST_SESSION_ID").pipe(Config.withDefault(""))
      : Config.succeed(""),
  BROWSER_HOST_TOKEN:
    stage === "development"
      ? Config.redacted("BROWSER_HOST_TOKEN").pipe(Config.withDefault(Redacted.make("")))
      : Config.succeed(Redacted.make("")),
});
