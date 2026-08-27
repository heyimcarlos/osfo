/* oxlint-disable osfo/no-unknown-parameters, eslint/no-underscore-dangle -- This handler owns the Cloudflare RPC trust boundary, and RPC errors use the standard _tag discriminator. */

import {
  Api,
  CurrentUser,
  SkillChangeResponse,
  SkillConflict,
  SkillDeletionPresentation,
  SkillDeletionResponse,
  SkillNotFound,
  SkillsSummary,
  SkillsUnavailable,
  type SkillChangeRequest,
  type SkillDeletionRequest,
} from "@osfo/api";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { UserId } from "../domain";
import type { DbUnavailable } from "../db";
import { AgentDirectory } from "../services/agent-directory";

interface SkillsDirectoryStub {
  readonly changePersonalSkill: (
    agentId: string,
    input: { readonly actor: Actor; readonly change: SkillChangeRequest },
  ) => Promise<SkillChangeResponse | SkillRpcFailure | null>;
  readonly deletePersonalSkillFromSettings: (
    agentId: string,
    input: {
      readonly actor: Actor;
      readonly reference: string;
      readonly request: SkillDeletionRequest;
    },
  ) => Promise<SkillDeletionResponse | SkillRpcFailure | null>;
  readonly inspectPersonalSkills: (
    agentId: string,
    actor: Actor,
  ) => Promise<SkillsSummary | SkillRpcFailure | null>;
  readonly presentPersonalSkillDeletion: (
    agentId: string,
    input: { readonly actor: Actor; readonly reference: string },
  ) => Promise<SkillDeletionPresentation | SkillRpcFailure | null>;
}

interface SkillRpcFailure {
  readonly _tag: string;
}

interface Actor {
  readonly decisionReference: string;
  readonly userId: string;
}

/** Cloudflare Directory binding needed by authenticated Skill controls. */
export interface Bindings {
  readonly OSFO_DIRECTORY: {
    readonly getByName: (identity: string) => SkillsDirectoryStub;
  };
}

/** Implement authenticated personal Skill inspection and lifecycle routes. */
export const layer = (bindings: Bindings) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const directory = yield* AgentDirectory.make;
      const stub = bindings.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
      return HttpApiBuilder.group(Api, "skills", (handlers) =>
        handlers
          .handle("inspect", () =>
            withRoute(
              directory,
              (agentId, actor) =>
                validateSkillRpcResponse(stub.inspectPersonalSkills(agentId, actor), SkillsSummary),
              unavailable,
            ),
          )
          .handle("change", ({ payload }) =>
            withRoute(
              directory,
              (agentId, actor) =>
                validateSkillRpcResponse(
                  stub.changePersonalSkill(agentId, { actor, change: payload }),
                  SkillChangeResponse,
                ),
              mutationError,
            ),
          )
          .handle("presentDeletion", ({ params }) =>
            withRoute(
              directory,
              (agentId, actor) =>
                validateSkillRpcResponse(
                  stub.presentPersonalSkillDeletion(agentId, {
                    actor,
                    reference: params.reference,
                  }),
                  SkillDeletionPresentation,
                ),
              foundError,
            ),
          )
          .handle("delete", ({ params, payload }) =>
            withRoute(
              directory,
              (agentId, actor) =>
                validateSkillRpcResponse(
                  stub.deletePersonalSkillFromSettings(agentId, {
                    actor,
                    reference: params.reference,
                    request: payload,
                  }),
                  SkillDeletionResponse,
                ),
              mutationError,
            ),
          ),
      );
    }),
  );

const withRoute = <Value, Error, PublicError>(
  directory: AgentDirectory.Interface,
  use: (agentId: string, actor: Actor) => Effect.Effect<Value, Error>,
  mapError: (error: Error | AgentDirectory.AgentRouteNotFound | DbUnavailable) => PublicError,
) =>
  Effect.gen(function* () {
    const currentUser = yield* CurrentUser;
    const route = yield* directory.resolve(UserId.make(currentUser.userId));
    return yield* use(route.agentId, {
      decisionReference: `settings:${currentUser.authSessionId}`,
      userId: currentUser.userId,
    });
  }).pipe(Effect.mapError(mapError));

export const validateSkillRpcResponse = <SchemaValue extends Schema.Top>(
  promise: Promise<object | null>,
  schema: SchemaValue,
) =>
  Effect.tryPromise({
    try: () => promise,
    catch: unavailable,
  }).pipe(
    Effect.flatMap((value) =>
      Schema.is(schema)(value) ? Effect.succeed(value) : Effect.fail(rpcFailure(value)),
    ),
  );

const rpcFailure = (value: unknown) => {
  const tagged = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }))(value);
  if (Option.isSome(tagged) && tagged.value._tag === "PersonalSkillNotFound") {
    return new SkillNotFound({ message: "This Skill is not available." });
  }
  if (
    Option.isSome(tagged) &&
    (tagged.value._tag === "PersonalSkillConflict" ||
      tagged.value._tag === "PersonalSkillApprovalInvalid")
  ) {
    return new SkillConflict({ message: "This Skill changed. Refresh and try again." });
  }
  return unavailable();
};

const foundError = (error: unknown) => (Schema.is(SkillNotFound)(error) ? error : unavailable());

const mutationError = (error: unknown) => {
  if (Schema.is(SkillNotFound)(error)) return error;
  if (Schema.is(SkillConflict)(error)) return error;
  return unavailable();
};

const unavailable = () =>
  new SkillsUnavailable({
    message: "Skills are temporarily unavailable. Please try again.",
  });

export * as SkillsHandlers from "./skills";
