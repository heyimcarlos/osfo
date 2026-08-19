import { Think, type StreamCallback, type TurnConfig } from "@cloudflare/think";
import { Option, Schema } from "effect";

import { decodeOsfoStage } from "../../config";
import {
  invalidOsfoEnvironment,
  makeRegistrationDialogueRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../../layers";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function, effecttsgo/global-date -- Effect result tags, Cloudflare RPC, and absolute schedule boundaries require these forms. */

/** Small multilingual model used only for temporary registration conversation. */
export const registrationModel = "@cf/meta/llama-3.2-1b-instruct" as const;

const RegistrationReplyInput = Schema.Struct({
  eventId: Schema.String,
  locale: Schema.Literals(["en", "es"]),
  message: Schema.String,
  verifyUrl: Schema.String,
});
type RegistrationReply = typeof RegistrationReplyInput.Type;

interface StoredRegistrationDialogue {
  readonly expiresAt: number;
  readonly locale: "en" | "es";
  readonly verifyUrl: string;
}

/** Observable outcome from one invitation-scoped dialogue reply. */
export type RegistrationDialogueResult =
  | { readonly _tag: "RegistrationDialogueCompleted" }
  | { readonly _tag: "RegistrationDialogueUnavailable"; readonly message: string };

const stateKey = "registration-dialogue";
const registrationLifetimeMs = 24 * 60 * 60 * 1_000;

/** Temporary conversation for one Registration Invitation. */
export class RegistrationDialogue extends Think<Env> {
  override includeMcpTools = false;
  override maxSteps = 1;
  override workspaceBash = false;

  readonly #runtime = Option.map(decodeOsfoStage(this.env.OSFO_STAGE), (stage) =>
    makeRegistrationDialogueRuntime(this.ctx.id.name ?? this.ctx.id.toString(), stage),
  );

  override getModel(): typeof registrationModel {
    return registrationModel;
  }

  override getSystemPrompt(): string {
    return [
      "You are Osfo during registration only.",
      "Be warm, concise, a little quirky, and reply in the person's language.",
      "You may discuss what they want help with, but do not perform tasks or claim that registration is complete.",
      "Explain naturally that using Osfo requires registration.",
      "Do not include or ask for a link, phone number, code, payment, or other secret; the application provides the registration link.",
    ].join(" ");
  }

  override beforeTurn(): TurnConfig {
    return {
      activeTools: [],
      maxOutputTokens: 80,
      maxRetries: 0,
      maxSteps: 1,
      sendReasoning: false,
    };
  }

  /** Return the restricted runtime identity for local smoke verification. */
  probeRuntime(): Promise<RuntimeProbeResult> {
    return Option.match(this.#runtime, {
      onNone: () => Promise.resolve(invalidOsfoEnvironment),
      onSome: (runtime) => runtime.runPromise(probeExecutionUnit),
    });
  }

  /** Continue the temporary conversation and complete the caller's messenger stream. */
  async reply(
    input: typeof RegistrationReplyInput.Encoded,
    callback: StreamCallback,
  ): Promise<RegistrationDialogueResult> {
    const parsed = Schema.decodeExit(RegistrationReplyInput)(input);
    if (parsed._tag === "Failure") {
      return {
        _tag: "RegistrationDialogueUnavailable",
        message: "The Registration Dialogue input is invalid",
      };
    }

    let dialogue: StoredRegistrationDialogue;
    try {
      dialogue = await this.#open(parsed.value);
    } catch {
      return {
        _tag: "RegistrationDialogueUnavailable",
        message: "The Registration Dialogue could not be opened",
      };
    }

    await callback.onStart({ requestId: parsed.value.eventId });
    await callback.onEvent(
      JSON.stringify({
        delta: registrationPrompt(dialogue.locale, dialogue.verifyUrl),
        type: "text-delta",
      }),
    );

    try {
      const turn = await this.runTurn({
        input: {
          id: parsed.value.eventId,
          parts: [{ text: parsed.value.message, type: "text" }],
          role: "user",
        },
        mode: "wait",
      });
      const natural = assistantText(turn.message);
      if (natural !== null) {
        await callback.onEvent(JSON.stringify({ delta: `\n\n${natural}`, type: "text-delta" }));
      }
    } catch {
      // The deterministic registration link is already in the visible response.
    }

    await callback.onDone();
    return { _tag: "RegistrationDialogueCompleted" };
  }

  /** Delete the temporary Think Session and invitation-scoped state. */
  async deleteDialogue(): Promise<void> {
    await this.clearMessages();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  /** Delete temporary Think and dialogue data when the invitation expires. */
  async expireDialogue(): Promise<void> {
    await this.deleteDialogue();
  }

  async #open(input: RegistrationReply): Promise<StoredRegistrationDialogue> {
    const existing = await this.ctx.storage.get<StoredRegistrationDialogue>(stateKey);
    if (existing !== undefined) return existing;

    const dialogue = {
      expiresAt: Date.now() + registrationLifetimeMs,
      locale: input.locale,
      verifyUrl: input.verifyUrl,
    } satisfies StoredRegistrationDialogue;
    await this.schedule(new Date(dialogue.expiresAt), "expireDialogue", undefined, {
      idempotent: true,
    });
    await this.ctx.storage.put(stateKey, dialogue);
    return dialogue;
  }
}

const assistantText = (
  message:
    | {
        readonly parts: ReadonlyArray<
          { readonly text: string; readonly type: "text" } | { readonly type: string }
        >;
      }
    | undefined,
): string | null => {
  if (message === undefined) return null;
  const text = message.parts
    .filter(
      (part): part is { readonly text: string; readonly type: "text" } => part.type === "text",
    )
    .map((part) => part.text)
    .join("")
    .trim();
  return text.length === 0 ? null : text;
};

const registrationPrompt = (locale: "en" | "es", verifyUrl: string): string =>
  locale === "es"
    ? `Regístrate para seguir usando Osfo: ${verifyUrl}`
    : `Register to keep using Osfo: ${verifyUrl}`;
