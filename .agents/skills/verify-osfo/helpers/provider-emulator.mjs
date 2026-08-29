/* oxlint-disable effecttsgo/new-promise, effecttsgo/process-env -- This process adapter owns POSIX signal callbacks and the run identity supplied by control-osfo. */
import { startRunProviderEmulator } from "../../../../apps/worker/test/emulators/provider-emulator.ts";

const [originPath] = process.argv.slice(2);
if (originPath === undefined || originPath.length === 0) {
  throw new Error("Usage: provider-emulator.mjs <origin-path>");
}
const verificationRunId = process.env.OSFO_VERIFICATION_RUN_ID;
if (verificationRunId === undefined || !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(verificationRunId)) {
  throw new Error("OSFO_VERIFICATION_RUN_ID must name the run-owned provider");
}

const provider = await startRunProviderEmulator(verificationRunId);
await Bun.write(originPath, `${provider.origin}\n`);

let stop;
const stopped = new Promise((resolve) => {
  stop = resolve;
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await stopped;
await provider.close();
