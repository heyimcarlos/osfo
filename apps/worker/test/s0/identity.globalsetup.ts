/* oxlint-disable effecttsgo/async-function -- throwaway S0 spike harness, vitest lifecycle requires async */
/* oxlint-disable effecttsgo -- throwaway S0 spike harness code, plain Node is intentional */
import { startTwilioEmulator, stopTwilioEmulator } from "./twilio-emulator";

export async function setup(): Promise<void> {
  await startTwilioEmulator(9798);
}

export async function teardown(): Promise<void> {
  await stopTwilioEmulator();
}
