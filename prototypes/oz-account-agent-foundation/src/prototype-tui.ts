import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import {
  bindChannel,
  cancelSubmission,
  getHealth,
  readAgentState,
  scheduleReminder,
  sendMessage,
  type FoundationState,
} from "./prototype-client.ts";

const runSuffix = crypto.randomUUID();
const agentId = `oz-account-${runSuffix}`;
const channelIdentity = `whatsapp:prototype:${runSuffix}`;
const stableMessageId = `wamid.prototype.${crypto.randomUUID()}`;

type LabState = {
  checks: Record<string, "PASS" | "FAIL" | "PENDING">;
  lastAction: string;
  serverLog: string[];
  snapshot: FoundationState | null;
};

const state: LabState = {
  checks: {
    "activation recovery": "PENDING",
    "direct submission": "PENDING",
    "Drizzle D1 and DO migration": "PENDING",
    "Effect service adapter": "PENDING",
    "in-flight turn recovery": "PENDING",
    "local cold-activation state": "PENDING",
    idempotency: "PENDING",
    interruption: "PENDING",
    "scheduled alarm": "PENDING",
  },
  lastAction: "starting Alchemy local workerd",
  serverLog: [],
  snapshot: null,
};

let server: ChildProcess | null = null;
const prototypeDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const capture = (chunk: Buffer) => {
  state.serverLog = [...state.serverLog, ...chunk.toString().split("\n")]
    .filter((line) => line.trim().length > 0)
    .slice(-4);
};

const startServer = async () => {
  const child = spawn("bun", ["run", "dev:server"], {
    cwd: prototypeDirectory,
    detached: true,
    env: {
      ...process.env,
      ALCHEMY_STAGE: "prototype",
      CI: "1",
      CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
      CLOUDFLARE_API_TOKEN: "local-prototype-only",
      OPENROUTER_API_KEY: "local-prototype-only",
      OZ_PROTOTYPE_TOKEN: "local-prototype-only",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server = child;
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  for (let attempt = 0; attempt < 80; attempt++) {
    const healthy = await run(
      getHealth().pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      ),
    );
    if (healthy) return;
    if (child.exitCode !== null) {
      throw new Error(
        `Alchemy dev exited with code ${child.exitCode}: ${state.serverLog.join(" | ")}`,
      );
    }
    await wait(250);
  }
  throw new Error(`Alchemy dev did not become ready: ${state.serverLog.join(" | ")}`);
};

const stopServer = async () => {
  if (server?.pid && server.exitCode === null) {
    process.kill(-server.pid, "SIGTERM");
    await wait(750);
  }
  server = null;
};

const refresh = async () => {
  state.snapshot = await run(readAgentState(agentId));
};

const bind = async () => {
  await run(bindChannel({ agentId, channelIdentity }));
  state.lastAction = `bound ${channelIdentity} to ${agentId}`;
};

const directSubmission = async () => {
  const receipt = await run(
    sendMessage({ channelIdentity, messageId: stableMessageId, text: "Remember this prototype." }),
  );
  state.checks["direct submission"] = receipt.receipt.accepted ? "PASS" : "FAIL";
  state.lastAction = `submission ${receipt.receipt.submissionId} accepted=${receipt.receipt.accepted}`;
  await wait(800);
  await refresh();
};

const idempotentRetry = async () => {
  const first = await run(
    sendMessage({ channelIdentity, messageId: stableMessageId, text: "Retry same message." }),
  );
  const second = await run(
    sendMessage({ channelIdentity, messageId: stableMessageId, text: "Retry same message." }),
  );
  state.checks.idempotency =
    first.receipt.submissionId === second.receipt.submissionId && !second.receipt.accepted
      ? "PASS"
      : "FAIL";
  state.lastAction = `same submission=${first.receipt.submissionId}, retry accepted=${second.receipt.accepted}`;
  await refresh();
};

const interrupt = async () => {
  const messageId = `wamid.slow.${crypto.randomUUID()}`;
  const result = await run(
    sendMessage({ channelIdentity, messageId, text: "[slow] demonstrate interruption" }),
  );
  await wait(1_000);
  await run(cancelSubmission(agentId, result.receipt.submissionId));
  await wait(500);
  await refresh();
  const submission = state.snapshot?.submissions.find(
    (candidate) => candidate.submissionId === result.receipt.submissionId,
  );
  state.checks.interruption = submission?.status === "aborted" ? "PASS" : "FAIL";
  state.lastAction = `cancelled ${result.receipt.submissionId}, status=${submission?.status}`;
};

const schedule = async () => {
  const reminderId = `reminder-${crypto.randomUUID()}`;
  await run(
    scheduleReminder(agentId, {
      delaySeconds: 1,
      reminderId,
      text: "Alarm delivery survived outside the HTTP request.",
    }),
  );
  for (let attempt = 0; attempt < 12; attempt++) {
    await wait(500);
    await refresh();
    if (
      state.snapshot?.foundation.reminders.some((reminder) => reminder.reminderId === reminderId)
    ) {
      break;
    }
  }
  state.checks["scheduled alarm"] = state.snapshot?.foundation.reminders.some(
    (reminder) => reminder.reminderId === reminderId,
  )
    ? "PASS"
    : "FAIL";
  state.lastAction = `alarm delivery ${reminderId}`;
};

const restart = async () => {
  await refresh();
  const before = state.snapshot?.activationId;
  const receiptCount = state.snapshot?.foundation.receipts.length ?? 0;
  const messageIds = new Set(
    state.snapshot?.messages.map((message) => message.id) ?? [],
  );
  const recoveryMessageId = `wamid.recover.${crypto.randomUUID()}`;
  const recoveryReceipt = await run(
    sendMessage({
      channelIdentity,
      messageId: recoveryMessageId,
      text: "[recover] finish this turn after a cold activation.",
    }),
  );
  await wait(500);
  await stopServer();
  await startServer();
  const recoveredReceipt = await run(
    sendMessage({
      channelIdentity,
      messageId: stableMessageId,
      text: "Retry the original message after cold activation.",
    }),
  );
  let recoveredSubmissionStatus: string | undefined;
  for (let attempt = 0; attempt < 16; attempt++) {
    await refresh();
    recoveredSubmissionStatus = state.snapshot?.submissions.find(
      (submission) => submission.submissionId === recoveryReceipt.receipt.submissionId,
    )?.status;
    if (recoveredSubmissionStatus === "completed") break;
    await wait(500);
  }
  const recovered = state.snapshot;
  const after = state.snapshot?.activationId;
  const recoveryMessageCount =
    recovered?.messages.filter((message) => message.id === recoveryMessageId).length ?? 0;
  state.checks["activation recovery"] =
    before !== after &&
    (recovered?.foundation.receipts.length ?? 0) >= receiptCount &&
    messageIds.has(stableMessageId) &&
    recovered?.messages.some((message) => message.id === stableMessageId)
      ? "PASS"
      : "FAIL";
  state.checks["local cold-activation state"] =
    state.checks["activation recovery"] === "PASS" && !recoveredReceipt.receipt.accepted
      ? "PASS"
      : "FAIL";
  state.checks["Drizzle D1 and DO migration"] = recovered?.foundation.activation ? "PASS" : "FAIL";
  state.checks["in-flight turn recovery"] =
    recoveredSubmissionStatus === "completed" && recoveryMessageCount === 1 ? "PASS" : "FAIL";
  const effectAdapterPassed =
    recovered !== null &&
    recovered.foundation.activation?.lastActivationId === after &&
    recovered.foundation.receipts.some((receipt) => receipt.messageId === stableMessageId);
  state.checks["Effect service adapter"] = effectAdapterPassed ? "PASS" : "FAIL";
  state.lastAction =
    `restarted during ${recoveryReceipt.receipt.submissionId}, ` +
    `recovered=${recoveredSubmissionStatus}, activation ${before} -> ${after}`;
};

const runProbe = async () => {
  await bind();
  await directSubmission();
  await idempotentRetry();
  await interrupt();
  await schedule();
  await restart();
};

const render = () => {
  console.clear();
  console.log("\x1b[1mOz account-agent foundation prototype\x1b[0m");
  console.log(`\x1b[2mAgent\x1b[0m ${agentId}`);
  console.log(`\x1b[2mChannel\x1b[0m ${channelIdentity}`);
  console.log(`\x1b[2mLast action\x1b[0m ${state.lastAction}\n`);
  for (const [name, status] of Object.entries(state.checks)) {
    console.log(`${status.padEnd(7)} ${name}`);
  }
  console.log("\n\x1b[1mCurrent durable state\x1b[0m");
  console.log(JSON.stringify(state.snapshot, null, 2));
  console.log("\n\x1b[1mActions\x1b[0m");
  console.log("[b] bind  [m] message  [d] duplicate  [i] interrupt  [s] schedule");
  console.log("[r] restart and recover  [x] full probe  [q] quit");
  console.log("\nNOT RUN  live Cloudflare eviction and wake checkpoint (local command)");
};

const interactive = async () => {
  const terminal = createInterface({ input: stdin, output: stdout });
  render();
  while (true) {
    const command = (await terminal.question("\n> ")).trim().toLowerCase();
    if (command === "q") break;
    try {
      if (command === "b") await bind();
      if (command === "m") await directSubmission();
      if (command === "d") await idempotentRetry();
      if (command === "i") await interrupt();
      if (command === "s") await schedule();
      if (command === "r") await restart();
      if (command === "x") await runProbe();
    } catch (error) {
      state.lastAction = error instanceof Error ? error.message : String(error);
    }
    render();
  }
  terminal.close();
};

try {
  await startServer();
  if (process.argv.includes("--probe")) {
    await runProbe();
    render();
    process.exitCode = Object.values(state.checks).every((status) => status === "PASS") ? 0 : 1;
  } else {
    await interactive();
  }
} finally {
  await stopServer();
}
