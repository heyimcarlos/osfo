/* oxlint-disable osfo/no-unknown-parameters, osfo/no-unknown-returns -- This handler decodes the Directory RPC trust boundary. */
import {
  Api,
  BrowserTaskLiveView,
  BrowserTaskResumed,
  BrowserTasks,
  BrowserTasksUnavailable,
  CurrentUser,
  type BrowserTaskSelection,
  type CurrentUserValue,
} from "@osfo/api";
import { Effect, Layer, Schema } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import type { BrowserTaskControls } from "../agents/osfo/browser-task-controls";
import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { UserId } from "../domain";
import { AgentDirectory } from "../services/agent-directory";

interface DirectoryStub {
  readonly listBrowserTasks: (
    agentId: string,
    actor: BrowserTaskControls.Actor,
  ) => Promise<unknown>;
  readonly openBrowserTask: (
    agentId: string,
    input: BrowserTaskControls.Request,
  ) => Promise<unknown>;
  readonly resumeBrowserTask: (
    agentId: string,
    input: BrowserTaskControls.Request,
  ) => Promise<unknown>;
}

export interface Bindings {
  readonly OSFO_DIRECTORY: { readonly getByName: (name: string) => DirectoryStub };
}

export const layer = (bindings: Bindings) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const directory = yield* AgentDirectory.make;
      const stub = bindings.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
      return HttpApiBuilder.group(Api, "browserTasks", (handlers) =>
        handlers
          .handle("list", () =>
            withAgent(directory, (agentId, user) => listTasks(stub, agentId, user)),
          )
          .handle("open", ({ payload }) =>
            withAgent(directory, (agentId, user) => openTask(stub, agentId, user, payload)),
          )
          .handle("resume", ({ payload }) =>
            withAgent(directory, (agentId, user) => resumeTask(stub, agentId, user, payload)),
          ),
      );
    }),
  );

const withAgent = <Value>(
  directory: AgentDirectory.Interface,
  use: (agentId: string, user: CurrentUserValue) => Effect.Effect<Value, BrowserTasksUnavailable>,
) =>
  Effect.gen(function* () {
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
    );
    const user = yield* CurrentUser;
    const route = yield* directory.resolve(UserId.make(user.userId));
    return yield* use(route.agentId, user);
  }).pipe(Effect.mapError(unavailable));

export const listTasks = (stub: DirectoryStub, agentId: string, user: CurrentUserValue) =>
  rpc(() => stub.listBrowserTasks(agentId, actorFor(user)), BrowserTasks);

export const openTask = (
  stub: DirectoryStub,
  agentId: string,
  user: CurrentUserValue,
  selection: BrowserTaskSelection,
) =>
  rpc(
    () => stub.openBrowserTask(agentId, { actor: actorFor(user), taskId: selection.taskId }),
    BrowserTaskLiveView,
  ).pipe(Effect.filterOrFail((result) => result.taskId === selection.taskId, unavailable));

export const resumeTask = (
  stub: DirectoryStub,
  agentId: string,
  user: CurrentUserValue,
  selection: BrowserTaskSelection,
) =>
  rpc(
    () => stub.resumeBrowserTask(agentId, { actor: actorFor(user), taskId: selection.taskId }),
    BrowserTaskResumed,
  ).pipe(Effect.filterOrFail((result) => result.taskId === selection.taskId, unavailable));

const actorFor = (user: CurrentUserValue): BrowserTaskControls.Actor => ({
  _tag: "AuthSession",
  authSessionId: user.authSessionId,
  expiresAt: user.authSessionExpiresAt.toISOString(),
  userId: user.userId,
});

const rpc = <S extends Schema.Top>(call: () => Promise<unknown>, schema: S) =>
  Effect.tryPromise({ try: call, catch: unavailable }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(unavailable),
  );

const unavailable = () =>
  new BrowserTasksUnavailable({
    message: "Browser controls are temporarily unavailable. Please refresh.",
  });

export * as BrowserTaskHandlers from "./browser-tasks";
