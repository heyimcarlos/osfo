import { Think } from "@cloudflare/think";
import type { ThinkSubmissionInspection } from "@cloudflare/think";
import type { LanguageModel } from "ai";
import type { UIMessage } from "ai";
import { AccountAgentRuntime } from "./account-agent-runtime.ts";
import type { FoundationSnapshot } from "./account-agent-runtime.ts";
import {
  assertChannelBinding,
  readFoundationSnapshot,
  recordActivation,
  recordReceipt,
  recordReminder,
} from "./account-agent-runtime.ts";
import { makePrototypeModel } from "./prototype-model.ts";

export interface PrototypeEnv extends Cloudflare.Env {
  readonly ACCOUNT_AGENT: DurableObjectNamespace<AccountAgent>;
  readonly DIRECTORY: D1Database;
}

export type MessageAdmission = {
  readonly channelIdentity: string;
  readonly messageId: string;
  readonly text: string;
};

export class AccountAgent extends Think<PrototypeEnv> {
  readonly #activationId = crypto.randomUUID();
  readonly #runtime: AccountAgentRuntime;

  override chatRecovery = {
    maxAttempts: 3,
    terminalMessage: "Oz was interrupted before it could safely finish. Please retry.",
  };

  constructor(ctx: DurableObjectState, env: PrototypeEnv) {
    super(ctx, env);
    this.#runtime = AccountAgentRuntime.make({
      directory: env.DIRECTORY,
      storage: ctx.storage,
    });
  }

  override getModel(): LanguageModel {
    return makePrototypeModel();
  }

  override getSystemPrompt(): string {
    return "You are the deterministic Oz account-agent foundation prototype.";
  }

  override async onStart(): Promise<void> {
    await this.#runtime.run(recordActivation(this.name, this.#activationId));
  }

  async #ready(): Promise<void> {
    await this.__unsafe_ensureInitialized();
  }

  async acceptMessage(input: MessageAdmission) {
    await this.#ready();
    await this.#runtime.run(assertChannelBinding(input.channelIdentity, this.name));
    const receipt = await this.submitMessages(
      [
        {
          id: input.messageId,
          parts: [{ text: input.text, type: "text" }],
          role: "user",
        },
      ],
      {
        idempotencyKey: `whatsapp:${input.messageId}`,
        metadata: { channelIdentity: input.channelIdentity, source: "prototype" },
      },
    );
    await this.#runtime.run(
      recordReceipt({
        accepted: receipt.accepted,
        messageId: input.messageId,
        status: receipt.status,
        submissionId: receipt.submissionId,
      }),
    );
    return receipt;
  }

  async cancelTurn(submissionId: string): Promise<void> {
    await this.#ready();
    await this.cancelSubmission(submissionId, "Cancelled by the acceptance prototype");
  }

  async scheduleReminder(input: {
    readonly delaySeconds: number;
    readonly reminderId: string;
    readonly text: string;
  }) {
    await this.#ready();
    return this.schedule(input.delaySeconds, "deliverReminder", input, { idempotent: true });
  }

  async deliverReminder(input: {
    readonly reminderId: string;
    readonly text: string;
  }): Promise<void> {
    await this.#runtime.run(recordReminder(input.reminderId, input.text));
  }

  async inspectFoundation(): Promise<{
    readonly activationId: string;
    readonly foundation: FoundationSnapshot;
    readonly messages: UIMessage[];
    readonly submissions: ThinkSubmissionInspection[];
  }> {
    await this.#ready();
    return {
      activationId: this.#activationId,
      foundation: await this.#runtime.run(readFoundationSnapshot(this.name)),
      messages: (await this.session.getHistory()) as UIMessage[],
      submissions: await this.listSubmissions({ limit: 25 }),
    };
  }
}
