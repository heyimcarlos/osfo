import { Schema } from "effect";

const [configPath, mode, ...extra] = process.argv.slice(2);
if (!configPath || mode !== "hosted" || extra.length > 0) {
  throw new Error("Usage: browser-binding.mjs <run-config> hosted");
}

const VerificationConfig = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^osfo-verification-[a-z0-9][a-z0-9-]{0,47}$/)),
  vars: Schema.Struct({ OSFO_STAGE: Schema.Literal("test") }),
  browser: Schema.Struct({
    binding: Schema.Literal("BROWSER"),
    remote: Schema.optionalKey(Schema.Boolean),
  }),
});
const config = await Schema.decodePromise(Schema.fromJsonString(VerificationConfig))(
  await Bun.file(configPath).text(),
  { onExcessProperty: "preserve" },
);
await Bun.write(
  configPath,
  JSON.stringify({ ...config, browser: { ...config.browser, remote: true } }, null, 2) + "\n",
);
