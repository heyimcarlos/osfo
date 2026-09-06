import {
  BrowserRenderingError,
  connectBrowserSession,
  createBrowserSession,
  deleteBrowserSession,
  listBrowserTargets,
} from "agents/browser";
import type { CdpSession } from "agents/browser";
import { Data, Effect, Random, Result, Schema, Schedule } from "effect";
import { handoff } from "./handoff";
import { adapterQualify } from "./adapter";

interface Env {
  BROWSER: Parameters<typeof createBrowserSession>[0];
  QUALIFICATION_TOKEN: string;
}

const targetResult = Schema.Struct({ targetId: Schema.String });
const frameResult = Schema.Struct({
  frameTree: Schema.Struct({ frame: Schema.Struct({ id: Schema.String }) }),
});
const evaluationResult = Schema.Struct({ result: Schema.Struct({ value: Schema.String }) });
const cookiesResult = Schema.Struct({
  cookies: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
});
const fixtureUrl = "https://hosted-browser-qualification.invalid/";

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/fixture") {
      return new Response(fixtureHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    const path = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      ![
        "/qualify",
        "/adapter-qualify",
        "/handoff/start",
        "/handoff/status",
        "/handoff/close",
      ].includes(path)
    ) {
      return new Response("Not found", { status: 404 });
    }
    const supplied = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
    const expected = new TextEncoder().encode(`Bearer ${env.QUALIFICATION_TOKEN}`);
    if (
      !env.QUALIFICATION_TOKEN ||
      supplied.length !== expected.length ||
      !crypto.subtle.timingSafeEqual(supplied, expected)
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (path === "/adapter-qualify") {
      return Effect.runPromise(
        adapterQualify(env.BROWSER, new URL("/fixture", request.url).href).pipe(
          Effect.match({
            onSuccess: (report) => Response.json(report, { status: report.passed ? 200 : 502 }),
            onFailure: (error) =>
              Response.json({ passed: false, failures: [error.message] }, { status: 502 }),
          }),
        ),
      );
    }
    if (path !== "/qualify") {
      return Effect.runPromise(
        handoff(request, env.BROWSER, env.QUALIFICATION_TOKEN).pipe(
          Effect.match({
            onSuccess: (result) => Response.json(result),
            onFailure: (error) => Response.json({ error: error.message }, { status: 502 }),
          }),
        ),
      );
    }
    return Effect.runPromise(
      qualify(env.BROWSER).pipe(
        Effect.map((report) => Response.json(report, { status: report.passed ? 200 : 502 })),
      ),
    );
  },
};

class QualificationFailure extends Data.TaggedError("QualificationFailure")<{
  message: string;
  cause?: unknown;
}> {}

const call = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new QualificationFailure({
        message: cause instanceof Error ? cause.message : "Browser provider operation failed",
        cause,
      }),
  });

const qualify = Effect.fn("HostedBrowserQualification.run")(function* (binding: Env["BROWSER"]) {
  const created: Array<string> = [];
  const deleted: Array<string> = [];
  const checks: Array<string> = [];
  const runId = `${yield* Random.nextInt}-${yield* Random.nextInt}`;
  const firstValue = `${runId}-first`;
  const secondValue = `${runId}-second`;
  const proof = Effect.gen(function* () {
    const first = yield* call(() => createBrowserSession(binding, { keepAliveMs: 600000 }));
    created.push(first.sessionId);
    const second = yield* call(() => createBrowserSession(binding, { keepAliveMs: 600000 }));
    created.push(second.sessionId);
    if (first.sessionId === second.sessionId)
      return yield* new QualificationFailure({
        message: "Provider returned the same session twice",
      });
    checks.push("distinct-sessions");
    const firstTarget = yield* withConnection(binding, first.sessionId, (cdp) =>
      createFixture(cdp, firstValue),
    );
    yield* withConnection(binding, second.sessionId, (cdp) =>
      Effect.gen(function* () {
        yield* assertCookies(cdp, undefined);
        const target = yield* createFixture(cdp, secondValue);
        yield* assertFixture(cdp, target, secondValue);
      }),
    );
    checks.push("cookie-and-dom-isolation");
    yield* withConnection(binding, first.sessionId, (cdp) =>
      assertFixture(cdp, firstTarget, firstValue),
    );
    checks.push("same-session-reconnect");
    return undefined;
  });
  const outcome = yield* Effect.result(proof);
  const cleanup = yield* Effect.forEach(created, (id) =>
    Effect.result(
      call(() => deleteBrowserSession(binding, id)).pipe(
        Effect.andThen(
          call(() => listBrowserTargets(binding, id)).pipe(
            Effect.matchEffect({
              onSuccess: () =>
                Effect.fail(
                  new QualificationFailure({
                    message: "Deleted browser session remains accessible",
                  }),
                ),
              onFailure: (error) =>
                error.cause instanceof BrowserRenderingError &&
                [404, 410].includes(error.cause.status)
                  ? Effect.void
                  : Effect.fail(error),
            }),
            Effect.retry({ times: 9, schedule: Schedule.spaced("250 millis") }),
          ),
        ),
        Effect.tap(() => Effect.sync(() => deleted.push(id))),
      ),
    ),
  );
  const failures = [outcome, ...cleanup].flatMap((result) =>
    Result.isFailure(result) ? [result.failure.message] : [],
  );
  if (created.length === 2 && deleted.length === 2) checks.push("both-deletions-confirmed-absent");
  return {
    passed: failures.length === 0 && checks.length === 4,
    runId,
    checks,
    createdSessions: created.length,
    deletedSessions: deleted.length,
    failures,
  };
});

const withConnection = <A, E>(
  binding: Env["BROWSER"],
  id: string,
  use: (cdp: CdpSession) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    call(() => connectBrowserSession(binding, id, 10000)),
    use,
    (cdp) => Effect.sync(() => cdp.disconnect()),
  );

const createFixture = Effect.fn("HostedBrowserQualification.createFixture")(function* (
  cdp: CdpSession,
  value: string,
) {
  const target = yield* call(() => cdp.send("Target.createTarget", { url: "about:blank" })).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(targetResult)),
  );
  const sessionId = yield* call(() => cdp.attachToTarget(target.targetId));
  const frame = yield* call(() => cdp.send("Page.getFrameTree", {}, { sessionId })).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(frameResult)),
  );
  yield* call(() =>
    cdp.send(
      "Page.setDocumentContent",
      {
        frameId: frame.frameTree.frame.id,
        html: `<html><body><p id="fixture">${value}</p></body></html>`,
      },
      { sessionId },
    ),
  );
  yield* call(() =>
    cdp.send("Network.setCookie", { name: "qualification", value, url: fixtureUrl }, { sessionId }),
  );
  return target.targetId;
});

const assertFixture = Effect.fn("HostedBrowserQualification.assertFixture")(function* (
  cdp: CdpSession,
  targetId: string,
  expected: string,
) {
  const sessionId = yield* call(() => cdp.attachToTarget(targetId));
  const result = yield* call(() =>
    cdp.send(
      "Runtime.evaluate",
      { expression: 'document.getElementById("fixture").textContent', returnByValue: true },
      { sessionId },
    ),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(evaluationResult)));
  if (result.result.value !== expected)
    return yield* new QualificationFailure({
      message: "DOM state differs from this session's fixture",
    });
  yield* assertCookies(cdp, expected, sessionId);
  return undefined;
});

const assertCookies = Effect.fn("HostedBrowserQualification.assertCookies")(function* (
  cdp: CdpSession,
  expected: string | undefined,
  sessionId?: string,
) {
  const result = yield* call(() =>
    cdp.send("Storage.getCookies", {}, sessionId ? { sessionId } : undefined),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(cookiesResult)));
  const values = result.cookies
    .filter((cookie) => cookie.name === "qualification")
    .map((cookie) => cookie.value);
  if (
    expected === undefined ? values.length !== 0 : values.length !== 1 || values[0] !== expected
  ) {
    return yield* new QualificationFailure({
      message: "Cookie state differs from this session's fixture",
    });
  }
  return undefined;
});

const fixtureHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Hosted browser test fixture</title>
<body><main><h1>Hosted browser test fixture</h1>
<p>This page only creates a synthetic receipt inside this browser. Use invented test data.</p>
<label for="reference">Synthetic reference</label><input id="reference" value="browser-test" maxlength="80">
<button id="record" type="button">Record test receipt</button>
<p id="receipt" role="status">No receipt recorded.</p>
<script>
document.getElementById("record").addEventListener("click", () => {
  const reference = document.getElementById("reference").value;
  document.cookie = "qualification_receipt=" + encodeURIComponent(reference) + "; Path=/; SameSite=Strict; Secure";
  document.getElementById("receipt").textContent = "Test receipt recorded: " + reference;
});
</script></main></body></html>`;
