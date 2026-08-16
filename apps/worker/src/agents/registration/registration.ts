import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";

import { decodeOsfoStage } from "../../env";
import {
  invalidOsfoEnvironment,
  makeRegistrationDialogueRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../../layers";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function, effecttsgo/global-date -- Cloudflare RPC, tags, and absolute alarm boundaries require these forms. */

/** Pinned multilingual Workers AI model for the one restricted Registration Turn. */
export const registrationModel = "@cf/meta/llama-3.1-8b-instruct-fp8" as const;

const BeginRegistrationInput = Schema.Struct({
  eventId: Schema.String,
  locale: Schema.Literals(["en", "es"]),
  message: Schema.String,
  verifyUrl: Schema.String,
});
type BeginRegistrationEncoded = typeof BeginRegistrationInput.Encoded;

interface StoredRegistrationTurn {
  readonly eventId: string;
  readonly expiresAt: number;
  readonly locale: "en" | "es";
  readonly message: string;
  readonly response: string | null;
  readonly verifyUrl: string;
}

/** Observable result from the invitation-scoped restricted turn. */
export type RegistrationTurnResult =
  | { readonly _tag: "RegistrationTurnCompleted"; readonly response: string }
  | { readonly _tag: "RegistrationTurnUnavailable"; readonly message: string };

const stateKey = "registration-turn";
const registrationLifetimeMs = 24 * 60 * 60 * 1_000;

/** Invitation-scoped Durable Object that hosts the restricted Registration Agent. */
export class RegistrationDialogue extends DurableObject<Env> {
  readonly #runtime = Option.map(decodeOsfoStage(this.env.OSFO_STAGE), (stage) =>
    makeRegistrationDialogueRuntime(this.ctx.id.name ?? this.ctx.id.toString(), stage),
  );

  /** Return the restricted runtime identity for local smoke verification. */
  probeRuntime(): Promise<RuntimeProbeResult> {
    return Option.match(this.#runtime, {
      onNone: () => Promise.resolve(invalidOsfoEnvironment),
      onSome: (runtime) => runtime.runPromise(probeExecutionUnit),
    });
  }

  /** Run at most one natural model response, then return a deterministic registration prompt. */
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
      };
    }
    if (existing !== undefined && existing.response !== null) {
      return {
        _tag: "RegistrationTurnCompleted",
        response: existing.response,
      };
    }

    const expiresAt = existing?.expiresAt ?? Date.now() + registrationLifetimeMs;
    await this.ctx.storage.put<StoredRegistrationTurn>(stateKey, {
      eventId: value.eventId,
      expiresAt,
      locale: value.locale,
      message: value.message,
      response: null,
      verifyUrl: value.verifyUrl,
    });
    await this.ctx.storage.setAlarm(expiresAt);

    try {
      const generated = await this.env.AI.run(registrationModel, {
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content:
              "You are Osfo during registration only. Reply once in the requested language. Acknowledge what the person wants help with in one short sentence. Do not start work, use tools, claim memory, or claim that registration is complete.",
          },
          {
            role: "user",
            content: `Language: ${value.locale}. Request: ${value.message}`,
          },
        ],
        temperature: 0.2,
      });
      const natural = generated.response?.trim();
      if (natural === undefined || natural.length === 0) {
        return {
          _tag: "RegistrationTurnUnavailable",
          message: "The Registration Turn did not return a response",
        };
      }
      const response = `${natural} ${deterministicPrompt(value.locale, value.verifyUrl)}`;
      await this.ctx.storage.put<StoredRegistrationTurn>(stateKey, {
        eventId: value.eventId,
        expiresAt,
        locale: value.locale,
        message: value.message,
        response,
        verifyUrl: value.verifyUrl,
      });
      return { _tag: "RegistrationTurnCompleted", response };
    } catch {
      return {
        _tag: "RegistrationTurnUnavailable",
        message: "The Registration Turn is temporarily unavailable",
      };
    }
  }

  /** Delete the temporary dialogue and transcript after registration. */
  async deleteDialogue(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  /** Delete temporary dialogue data when its Registration Invitation expires. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

const deterministicPrompt = (locale: "en" | "es", verifyUrl: string): string =>
  locale === "es"
    ? `Usa tu enlace de registro para continuar: ${verifyUrl}`
    : `Use your registration link to continue: ${verifyUrl}`;
