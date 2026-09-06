/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-fetch, effecttsgo/global-date -- Standalone Node verification launcher owns filesystem, HTTP, and evidence timestamp boundaries. */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = process.argv[2];
if (!directory || !isAbsolute(directory) || !directory.startsWith("/tmp/")) {
  throw new Error("Usage: node prepare.mjs /tmp/hosted-browser-qualification-UNIQUE");
}
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(sourceDirectory, "../../..");
const workerRequire = createRequire(resolve(repository, "apps/worker/package.json"));
const rootRequire = createRequire(resolve(repository, "package.json"));
await mkdir(directory, { mode: 0o700 });
const token = randomBytes(32).toString("hex");
await writeFile(resolve(directory, ".dev.vars"), `QUALIFICATION_TOKEN=${token}\n`, {
  mode: 0o600,
  flag: "wx",
});
await writeFile(
  resolve(directory, "wrangler.jsonc"),
  JSON.stringify(
    {
      name: "hosted-browser-qualification",
      main: resolve(sourceDirectory, "worker.ts"),
      compatibility_date: "2026-08-12",
      compatibility_flags: ["nodejs_compat"],
      browser: { binding: "BROWSER", remote: true },
      alias: {
        "agents/browser": workerRequire.resolve("agents/browser"),
        "@osfo/api/browser-host": workerRequire.resolve("@osfo/api/browser-host"),
        "hosted-browser-provider-under-test": resolve(
          repository,
          "apps/worker/src/services/hosted-browser-provider.ts",
        ),
        effect: rootRequire.resolve("effect"),
      },
      observability: { enabled: false },
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600, flag: "wx" },
);
process.stdout.write(`Prepared ${directory}/wrangler.jsonc. The token remains in .dev.vars.\n`);
