import { Think } from "@cloudflare/think";
import { Option, Schema } from "effect";

import { decodeOsfoStage } from "../../config";
import {
  invalidOsfoEnvironment,
  makeRegistrationDialogueRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../../layers";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function, effecttsgo/global-date -- Cloudflare RPC, Think submission tags, and absolute schedule boundaries require these forms. */

/** Pinned multilingual Workers AI model for the one restricted Registration Turn. */
export const registrationModel = "@cf/meta/llama-3.1-8b-instruct-fp8" as const;

const BeginRegistrationInput = Schema.Struct({
  eventId: Schema.String,
  locale: Schema.Literals(["en", "es"]),
  message: Schema.String,
  verifyUrl: Schema.String,
});
type BeginRegistrationEncoded = typeof BeginRegistrationInput.Encoded;
type BeginRegistration = typeof BeginRegistrationInput.Type;

interface StoredRegistrationTurn {
  readonly eventId: string;
  readonly expiresAt: number;
  readonly locale: "en" | "es";
  readonly response: string | null;
  readonly verifyUrl: string;
}

/** Observable result from the invitation-scoped restricted turn. */
export type RegistrationTurnResult =
  | {
      readonly _tag: "RegistrationTurnCompleted";
      readonly response: string;
      readonly verifyUrl: string;
    }
  | { readonly _tag: "RegistrationTurnUnavailable"; readonly message: string };

const stateKey = "registration-turn";
const registrationLifetimeMs = 24 * 60 * 60 * 1_000;

/** Invitation-scoped restricted Think harness for the ephemeral Registration Turn. */
export class RegistrationDialogue extends Think<Env> {
  override maxSteps = 1;
  override workspaceBash = false;

  readonly #runtime = Option.map(decodeOsfoStage(this.env.OSFO_STAGE), (stage) =>
    makeRegistrationDialogueRuntime(this.ctx.id.name ?? this.ctx.id.toString(), stage),
  );

  readonly #activeTurns = new Map<string, Promise<RegistrationTurnResult>>();

  /** Select the pinned Workers AI model through Think's supported model interface. */
  override getModel(): typeof registrationModel {
    return registrationModel;
  }

  /** Give the one Registration Turn its restricted operating policy. */
  override getSystemPrompt(): string {
    return [
      "You are Osfo during registration only.",
      "Reply once in the language named in the user message.",
      "If the person states a clear need, acknowledge that need briefly.",
      "If the message is vague, ask naturally what the person wants help with.",
      "Do not start work, use tools, claim memory, claim personal Agent capabilities, or claim that registration is complete.",
      "Return only the natural response. The application adds the registration continuation separately.",
    ].join(" ");
  }

  /** Return the restricted runtime identity for local smoke verification. */
  probeRuntime(): Promise<RuntimeProbeResult> {
    return Option.match(this.#runtime, {
      onNone: () => Promise.resolve(invalidOsfoEnvironment),
      onSome: (runtime) => runtime.runPromise(probeExecutionUnit),
    });
  }

  /** Admit at most one natural Think turn, then return a deterministic registration prompt. */
  async begin(input: BeginRegistrationEncoded): Promise<RegistrationTurnResult> {
    const parsed = Schema.decodeExit(BeginRegistrationInput)(input);
    if (parsed._tag === "Failure") {
      return {
        _tag: "RegistrationTurnUnavailable",
        message: "The Registration Turn input is invalid",
      };
    }
    const value = parsed.value;
    const existing = await this.ctx.storage.get<StoredRegistrationTurn>(stateKey);
    if (existing !== undefined && existing.eventId !== value.eventId) {
      return {
        _tag: "RegistrationTurnCompleted",
        response: deterministicPrompt(existing.locale, existing.verifyUrl),
        verifyUrl: existing.verifyUrl,
      };
    }
    if (existing?.response !== null && existing?.response !== undefined) {
      return {
        _tag: "RegistrationTurnCompleted",
        response: existing.response,
        verifyUrl: existing.verifyUrl,
      };
    }

    const expiresAt = existing?.expiresAt ?? Date.now() + registrationLifetimeMs;
    if (existing === undefined) {
      await this.ctx.storage.put<StoredRegistrationTurn>(stateKey, {
        eventId: value.eventId,
        expiresAt,
        locale: value.locale,
        response: null,
        verifyUrl: value.verifyUrl,
      });
      await this.schedule(new Date(expiresAt), "expireDialogue", undefined, { idempotent: true });
    }

    const active = this.#activeTurns.get(value.eventId);
    if (active !== undefined) return await active;

    const turn = this.#runFirstTurn(value, expiresAt).finally(() => {
      this.#activeTurns.delete(value.eventId);
    });
    this.#activeTurns.set(value.eventId, turn);
    return await turn;
  }

  /** Delete the temporary Think Session and invitation-scoped dialogue after registration. */
  async deleteDialogue(): Promise<void> {
    await this.clearMessages();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  /** Delete temporary Think and dialogue data when the Registration Invitation expires. */
  async expireDialogue(): Promise<void> {
    await this.deleteDialogue();
  }

  async #runFirstTurn(
    input: BeginRegistration,
    expiresAt: number,
  ): Promise<RegistrationTurnResult> {
    try {
      const submission = await this.submitMessages(
        [
          {
            id: input.eventId,
            role: "user",
            parts: [
              {
                type: "text",
                text: `Language: ${input.locale}. Message: ${input.message}`,
              },
            ],
          },
        ],
        { idempotencyKey: input.eventId },
      );
      await this._drainThinkSubmissions();
      const inspection = await this.inspectSubmission(submission.submissionId);
      if (inspection?.status !== "completed") {
        return {
          _tag: "RegistrationTurnUnavailable",
          message: "The Registration Turn is temporarily unavailable",
        };
      }

      const natural = latestAssistantText(await this.getMessages());
      if (natural === null) {
        return {
          _tag: "RegistrationTurnUnavailable",
          message: "The Registration Turn did not return a response",
        };
      }
      const response = `${natural} ${deterministicPrompt(input.locale, input.verifyUrl)}`;
      await this.ctx.storage.put<StoredRegistrationTurn>(stateKey, {
        eventId: input.eventId,
        expiresAt,
        locale: input.locale,
        response,
        verifyUrl: input.verifyUrl,
      });
      return { _tag: "RegistrationTurnCompleted", response, verifyUrl: input.verifyUrl };
    } catch {
      return {
        _tag: "RegistrationTurnUnavailable",
        message: "The Registration Turn is temporarily unavailable",
      };
    }
  }
}

const latestAssistantText = (
  messages: Awaited<ReturnType<RegistrationDialogue["getMessages"]>>,
): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    return text.length === 0 ? null : text;
  }
  return null;
};

const deterministicPrompt = (locale: "en" | "es", verifyUrl: string): string =>
  locale === "es"
    ? `Usa tu enlace de registro para continuar: ${verifyUrl}`
    : `Use your registration link to continue: ${verifyUrl}`;
