import { startProviderEmulator } from "../../../../apps/worker/test/emulators/provider-emulator.ts";

const [originPath] = process.argv.slice(2);
if (originPath === undefined || originPath.length === 0) {
  throw new Error("Usage: provider-emulator.mjs <origin-path>");
}

const provider = await startProviderEmulator();
await Bun.write(originPath, `${provider.origin}\n`);
console.log(`provider ready origin=${provider.origin}`);

let stop;
const stopped = new Promise((resolve) => {
  stop = resolve;
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await stopped;
await provider.close();
console.log("provider stopped");
