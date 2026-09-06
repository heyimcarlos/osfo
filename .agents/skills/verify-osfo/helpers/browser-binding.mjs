/* oxlint-disable effecttsgo/node-builtin-import -- This local CLI writes the run-owned secret file with exclusive creation and restrictive POSIX permissions. */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Option, Schema } from "effect";

const Binding = Schema.Struct({
  BROWSER_HOST_ENDPOINT: Schema.Literal("http://127.0.0.1:39270/inventory"),
  BROWSER_HOST_OWNER_USER_ID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  BROWSER_HOST_SESSION_ID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  BROWSER_HOST_TOKEN: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(512), Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  BROWSER_HOST_ALLOWED_ORIGINS: Schema.Literal('["http://127.0.0.1:39271"]'),
});
const [configPath, bindingPath, owner] = process.argv.slice(2);
if (!configPath || !bindingPath || !owner) throw new Error("Expected run config, private binding, and registered owner");
const decoded = Schema.decodeOption(Schema.fromJsonString(Binding))(await Bun.file(bindingPath).text(), { onExcessProperty: "error" });
if (Option.isNone(decoded)) throw new Error("Invalid private browser binding");
const binding = decoded.value;
if (binding.BROWSER_HOST_OWNER_USER_ID !== owner) throw new Error("Browser binding owner differs from the authenticated run User");
const config = await Bun.file(configPath).json();
if (config.vars?.OSFO_STAGE !== "test" || !config.name?.startsWith("osfo-verification-")) throw new Error("Only a run-owned verification config can bind this fixture");
if (config.vars.BROWSER_HOST_OWNER_USER_ID) throw new Error("Browser binding is single-use for this run");
const { BROWSER_HOST_TOKEN, ...publicBinding } = binding;
// Wrangler loads adjacent .dev.vars as secret_text and redacts these values in startup logs.
await writeFile(join(dirname(configPath), ".dev.vars"), `BROWSER_HOST_TOKEN=${BROWSER_HOST_TOKEN}\n`, { mode: 0o600, flag: "wx" });
await Bun.write(configPath, JSON.stringify({ ...config, vars: { ...config.vars, ...publicBinding } }, null, 2) + "\n");
