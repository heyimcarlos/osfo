import { browserHostConfig } from "@osfo/worker/config";
import { Config, Effect, Redacted, Result, Schema, SchemaIssue } from "effect";

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

/** Production is opt-in; previews never inherit a provisioned owner's browser. */
export const browserHostBindings = (stage: string) => {
  const forwarded = stage === "development" || stage === "production";
  const bindings = {
    BROWSER_HOST_ALLOWED_ORIGINS: forwarded
      ? Config.string("BROWSER_HOST_ALLOWED_ORIGINS").pipe(Config.withDefault("[]"))
      : Config.succeed("[]"),
    BROWSER_HOST_ENDPOINT: forwarded
      ? Config.string("BROWSER_HOST_ENDPOINT").pipe(Config.withDefault(""))
      : Config.succeed(""),
    BROWSER_HOST_OWNER_USER_ID: forwarded
      ? Config.string("BROWSER_HOST_OWNER_USER_ID").pipe(Config.withDefault(""))
      : Config.succeed(""),
    BROWSER_HOST_SESSION_ID: forwarded
      ? Config.string("BROWSER_HOST_SESSION_ID").pipe(Config.withDefault(""))
      : Config.succeed(""),
    BROWSER_HOST_TOKEN: forwarded
      ? Config.redacted("BROWSER_HOST_TOKEN").pipe(Config.withDefault(Redacted.make("")))
      : Config.succeed(Redacted.make("")),
  };
  if (stage !== "production") return bindings;
  const validated = Config.all(bindings).pipe(
    Config.mapOrFail((values) => {
      const result = browserHostConfig("production", {
        ...values,
        BROWSER_HOST_TOKEN: Redacted.value(values.BROWSER_HOST_TOKEN),
      });
      return Result.isFailure(result)
        ? Effect.fail(
            new Config.ConfigError(
              new Schema.SchemaError(new SchemaIssue.InvalidValue({ message: result.failure })),
            ),
          )
        : Effect.succeed(values);
    }),
  );
  return {
    BROWSER_HOST_ALLOWED_ORIGINS: validated.pipe(
      Config.map((values) => values.BROWSER_HOST_ALLOWED_ORIGINS),
    ),
    BROWSER_HOST_ENDPOINT: validated.pipe(Config.map((values) => values.BROWSER_HOST_ENDPOINT)),
    BROWSER_HOST_OWNER_USER_ID: validated.pipe(
      Config.map((values) => values.BROWSER_HOST_OWNER_USER_ID),
    ),
    BROWSER_HOST_SESSION_ID: validated.pipe(Config.map((values) => values.BROWSER_HOST_SESSION_ID)),
    BROWSER_HOST_TOKEN: validated.pipe(Config.map((values) => values.BROWSER_HOST_TOKEN)),
  };
};
