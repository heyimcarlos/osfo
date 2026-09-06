import {
  connectBrowserSession,
  createBrowserSession,
  deleteBrowserSession,
  BrowserRenderingError,
  listBrowserTargets,
} from "agents/browser";
import type { CdpSession } from "agents/browser";
import { Data, Effect, Schema } from "effect";

class HandoffFailure extends Data.TaggedError("HandoffFailure")<{
  message: string;
  cause?: unknown;
}> {}
const targetResult = Schema.Struct({ targetId: Schema.String });
const liveResult = Schema.Struct({ devtoolsFrontendUrl: Schema.String });
const provider = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new HandoffFailure({
        message: cause instanceof Error ? cause.message : "Handoff provider request failed",
        cause,
      }),
  });
type Binding = Parameters<typeof createBrowserSession>[0];
const connected = <A, E>(
  binding: Binding,
  id: string,
  run: (cdp: CdpSession) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    provider(() => connectBrowserSession(binding, id, 10000)),
    run,
    (cdp) => Effect.sync(() => cdp.disconnect()),
  );

export const handoff = Effect.fn("HostedBrowserQualification.handoff")(function* (
  request: Request,
  binding: Binding,
  token: string,
) {
  const url = new URL(request.url);
  const key = yield* provider(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
  );
  if (url.pathname === "/handoff/start") {
    const session = yield* provider(() => createBrowserSession(binding, { keepAliveMs: 600000 }));
    return yield* connected(binding, session.sessionId, (cdp) =>
      Effect.gen(function* () {
        const target = yield* provider(() =>
          cdp.send("Target.createTarget", { url: new URL("/fixture", url).href }),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(targetResult)));
        const attachment = yield* provider(() => cdp.attachToTarget(target.targetId));
        const live = yield* provider(() =>
          cdp.send(
            "Cloudflare.getLiveView",
            { targetId: target.targetId, mode: "tab", expiresInMs: 600000 },
            { sessionId: attachment },
          ),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(liveResult)));
        const started = yield* provider(() =>
          cdp.send(
            "Cloudflare.handoff",
            {
              targetId: target.targetId,
              instructions:
                "Enter an invented synthetic reference, record the test receipt, then press Done.",
              timeout: 600000,
            },
            { sessionId: attachment },
          ),
        );
        const state = yield* provider(() =>
          cdp.send(
            "Cloudflare.getHandoffState",
            { targetId: target.targetId },
            { sessionId: attachment },
          ),
        );
        const payload = `${session.sessionId}.${target.targetId}`;
        const signature = yield* provider(() =>
          crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
        );
        const handle = `${payload}.${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        return { handle, liveUrl: live.devtoolsFrontendUrl, started, state };
      }),
    ).pipe(
      Effect.onError(() =>
        provider(() => deleteBrowserSession(binding, session.sessionId)).pipe(Effect.orDie),
      ),
    );
  }
  const parts = (request.headers.get("X-Qualification-Handle") ?? "").split(".");
  const sessionId = parts[0];
  const targetId = parts[1];
  const signature = parts[2];
  if (
    parts.length !== 3 ||
    !sessionId ||
    !targetId ||
    !signature ||
    !/^[a-zA-Z0-9_-]+$/.test(sessionId) ||
    !/^[a-zA-Z0-9_-]+$/.test(targetId) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return yield* new HandoffFailure({ message: "Invalid qualification handle" });
  const signatureBytes = Uint8Array.from(signature.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  const valid = yield* provider(() =>
    crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(`${sessionId}.${targetId}`),
    ),
  );
  if (!valid) return yield* new HandoffFailure({ message: "Invalid qualification handle" });
  if (url.pathname === "/handoff/close") {
    yield* provider(() => deleteBrowserSession(binding, sessionId));
    const absent = yield* provider(() => listBrowserTargets(binding, sessionId)).pipe(
      Effect.match({
        onSuccess: () => false,
        onFailure: (error) =>
          error.cause instanceof BrowserRenderingError && [404, 410].includes(error.cause.status),
      }),
    );
    return { deleted: absent };
  }
  return yield* connected(binding, sessionId, (cdp) =>
    Effect.gen(function* () {
      const attachment = yield* provider(() => cdp.attachToTarget(targetId));
      const state = yield* provider(() =>
        cdp.send("Cloudflare.getHandoffState", { targetId }, { sessionId: attachment }),
      );
      const receipt = yield* provider(() =>
        cdp.send(
          "Runtime.evaluate",
          {
            expression: 'document.getElementById("receipt")?.textContent ?? "fixture-not-loaded"',
            returnByValue: true,
          },
          { sessionId: attachment },
        ),
      );
      return { state, receipt };
    }),
  );
});
