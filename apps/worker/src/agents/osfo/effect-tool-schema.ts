import { jsonSchema } from "ai";
import { Effect, Schema } from "effect";

/** Adapt an Effect Schema to the AI SDK without giving up Effect decoding. */
export const effectToolSchema = <T, E, RE>(schema: Schema.Codec<T, E, never, RE>) => {
  const document = Schema.toJsonSchemaDocument(schema);
  const providerSchema =
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions };
  return jsonSchema<T>(providerSchema, {
    validate: (value) =>
      Effect.runPromise(
        Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.match({
            onFailure: (error) => ({ error, success: false }) as const,
            onSuccess: (decoded) => ({ success: true, value: decoded }) as const,
          }),
        ),
      ),
  });
};
