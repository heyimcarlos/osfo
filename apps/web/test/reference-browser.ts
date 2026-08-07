import { NodeServices } from "@effect/platform-node";
import { AcceptanceReceipt } from "@osfo/api";
import { ThreadSnapshotSchema } from "@osfo/session";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const webDirectory = fileURLToPath(new URL("..", import.meta.url));
const viteBinary = join(webDirectory, "node_modules/vite/bin/vite.js");
const chromeCandidates = [
  process.env.CHROME_BINARY,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((candidate): candidate is string => candidate !== undefined);

const ThreadSnapshotFromJson = Schema.fromJsonString(ThreadSnapshotSchema);
const AcceptanceReceiptFromJson = Schema.fromJsonString(AcceptanceReceipt);
const EmptyObject = Schema.Record(Schema.String, Schema.Unknown);
const ChromeTargetSchema = Schema.Struct({
  webSocketDebuggerUrl: Schema.String,
});
const RuntimeEvaluationSchema = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
});
const ResponseBodySchema = Schema.Struct({
  base64Encoded: Schema.Boolean,
  body: Schema.String,
});
const CdpMessageFromJson = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.optional(
      Schema.Struct({
        code: Schema.Number,
        message: Schema.String,
      }),
    ),
    id: Schema.optional(Schema.Number),
    method: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Unknown),
    result: Schema.optional(Schema.Unknown),
  }),
);
const RequestWillBeSentSchema = Schema.Struct({
  request: Schema.Struct({ method: Schema.String, url: Schema.String }),
  requestId: Schema.String,
});
const ResponseReceivedSchema = Schema.Struct({
  requestId: Schema.String,
  response: Schema.Struct({ status: Schema.Number }),
});
const LoadingFinishedSchema = Schema.Struct({ requestId: Schema.String });

export class ReferenceBrowserError extends Data.TaggedError("ReferenceBrowserError")<{
  readonly operation: string;
  readonly cause?: unknown;
}> {}

const availablePort = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          server.close();
          reject(new ReferenceBrowserError({ operation: "resolve ephemeral port" }));
          return;
        }
        server.close((cause) => (cause === undefined ? resolve(address.port) : reject(cause)));
      });
    }),
  catch: (cause) => new ReferenceBrowserError({ operation: "reserve ephemeral port", cause }),
});

const collectProcessOutput = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  handle.all.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (output, chunk) => output + chunk,
    ),
  );

const runCommand = (
  command: string,
  arguments_: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
  },
) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      extendEnv: true,
      stdin: "ignore",
      forceKillAfter: "3 seconds",
    }).pipe(
      Effect.mapError(
        (cause) => new ReferenceBrowserError({ operation: `start ${command}`, cause }),
      ),
    );
    const output = yield* collectProcessOutput(handle).pipe(
      Effect.mapError(
        (cause) => new ReferenceBrowserError({ operation: `read ${command} output`, cause }),
      ),
    );
    const exitCode = yield* handle.exitCode.pipe(
      Effect.mapError(
        (cause) => new ReferenceBrowserError({ operation: `wait for ${command}`, cause }),
      ),
    );
    if (exitCode !== 0) {
      return yield* new ReferenceBrowserError({
        operation: `${command} exited with ${exitCode}: ${output}`,
      });
    }
  }).pipe(Effect.provide(NodeServices.layer));

const waitForHttp = (origin: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const available = yield* client.execute(HttpClientRequest.get(origin)).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (available) return;
      yield* Effect.sleep(50);
    }
    return yield* new ReferenceBrowserError({ operation: `wait for ${origin}` });
  });

const waitForProcessOutput = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  pattern: string,
  operation: string,
) => {
  const output: Array<string> = [];
  return handle.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.tap((line) => Effect.sync(() => output.push(line))),
    Stream.filter((line) => line.includes(pattern)),
    Stream.runHead,
    Effect.mapError((cause) => new ReferenceBrowserError({ operation, cause })),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new ReferenceBrowserError({ operation: `${operation}: ${output.join("\n")}` }),
          ),
        onSome: Effect.succeed,
      }),
    ),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(
          new ReferenceBrowserError({ operation: `${operation} timed out: ${output.join("\n")}` }),
        ),
    }),
  );
};

export interface ProductionReferenceClientOptions {
  readonly authenticationToken: string;
  readonly ingressOrigin: string;
  readonly threadId: string;
}

export const startProductionReferenceClient = (options: ProductionReferenceClientOptions) =>
  Effect.gen(function* () {
    yield* runCommand("bun", ["run", "build"], {
      cwd: webDirectory,
      env: {
        VITE_OSFO_AUTHENTICATION_TOKEN: options.authenticationToken,
        VITE_OSFO_THREAD_ID: options.threadId,
      },
    });
    const port = yield* availablePort;
    const origin = `http://127.0.0.1:${port}`;
    const preview = yield* ChildProcess.make(
      process.execPath,
      [viteBinary, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      {
        cwd: webDirectory,
        env: { OSFO_WEB_PROXY_ORIGIN: options.ingressOrigin },
        extendEnv: true,
        stdin: "ignore",
        forceKillAfter: "3 seconds",
      },
    ).pipe(
      Effect.mapError(
        (cause) => new ReferenceBrowserError({ operation: "start Vite production preview", cause }),
      ),
    );
    yield* waitForProcessOutput(preview, "Local:", "wait for Vite production preview");
    return { origin };
  }).pipe(Effect.provide(NodeServices.layer));

interface PendingCommand {
  readonly reject: (cause: unknown) => void;
  readonly resolve: (value: unknown) => void;
}

class CdpConnection {
  readonly #completedMessages: Array<string> = [];
  readonly #eventRequests: Array<string> = [];
  readonly #pending = new Map<number, PendingCommand>();
  readonly #requests = new Map<string, { readonly method: string; readonly url: string }>();
  readonly #successfulMessageResponses = new Set<string>();
  #nextId = 1;

  private constructor(
    readonly socket: WebSocket,
    readonly label: string,
  ) {
    socket.addEventListener("message", (event) => this.onMessage(event));
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new ReferenceBrowserError({ operation: `Chrome tab ${label} closed` }));
      }
      this.#pending.clear();
    });
  }

  static connect = (webSocketUrl: string, label: string) =>
    Effect.tryPromise({
      try: () =>
        new Promise<CdpConnection>((resolve, reject) => {
          const socket = new WebSocket(webSocketUrl);
          socket.addEventListener("open", () => resolve(new CdpConnection(socket, label)), {
            once: true,
          });
          socket.addEventListener("error", reject, { once: true });
        }),
      catch: (cause) =>
        new ReferenceBrowserError({ operation: `connect Chrome tab ${label}`, cause }),
    });

  private onMessage(event: MessageEvent) {
    if (typeof event.data !== "string") return;
    const decoded = Schema.decodeUnknownOption(CdpMessageFromJson)(event.data);
    if (Option.isNone(decoded)) return;
    const message = decoded.value;
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error === undefined) pending.resolve(message.result);
      else {
        pending.reject(
          new ReferenceBrowserError({
            operation: `Chrome command failed (${message.error.code}): ${message.error.message}`,
          }),
        );
      }
      return;
    }
    if (message.method === "Network.requestWillBeSent") {
      const request = Schema.decodeUnknownOption(RequestWillBeSentSchema)(message.params);
      if (Option.isSome(request)) {
        this.#requests.set(request.value.requestId, request.value.request);
        if (new URL(request.value.request.url).pathname.endsWith("/events")) {
          this.#eventRequests.push(request.value.request.url);
        }
      }
    }
    if (message.method === "Network.responseReceived") {
      const response = Schema.decodeUnknownOption(ResponseReceivedSchema)(message.params);
      if (Option.isSome(response) && response.value.response.status === 200) {
        const request = this.#requests.get(response.value.requestId);
        if (request?.method === "POST" && new URL(request.url).pathname.endsWith("/messages")) {
          this.#successfulMessageResponses.add(response.value.requestId);
        }
      }
    }
    if (message.method === "Network.loadingFinished") {
      const completed = Schema.decodeUnknownOption(LoadingFinishedSchema)(message.params);
      if (
        Option.isSome(completed) &&
        this.#successfulMessageResponses.has(completed.value.requestId)
      ) {
        this.#completedMessages.push(completed.value.requestId);
      }
    }
  }

  command = <A>(method: string, params: unknown, schema: Schema.Decoder<A>) =>
    Effect.tryPromise({
      try: () =>
        new Promise<unknown>((resolve, reject) => {
          const id = this.#nextId;
          this.#nextId += 1;
          this.#pending.set(id, { reject, resolve });
          this.socket.send(JSON.stringify({ id, method, params }));
        }),
      catch: (cause) =>
        new ReferenceBrowserError({ operation: `run ${method} in tab ${this.label}`, cause }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(
        (cause) =>
          new ReferenceBrowserError({ operation: `decode ${method} in tab ${this.label}`, cause }),
      ),
    );

  takeCompletedMessage = Effect.sync(() => this.#completedMessages.shift());
  eventRequestCount = Effect.sync(() => this.#eventRequests.length);

  close = Effect.sync(() => this.socket.close());
}

const waitFor = <A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
  ready: (value: A) => boolean,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = yield* effect;
      if (ready(value)) return value;
      yield* Effect.sleep(25);
    }
    return yield* new ReferenceBrowserError({ operation });
  });

const waitForDefined = <A, E, R>(operation: string, effect: Effect.Effect<A | undefined, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = yield* effect;
      if (value !== undefined) return value;
      yield* Effect.sleep(25);
    }
    return yield* new ReferenceBrowserError({ operation });
  });

const withDevice = (location: string, label: string) => {
  if (location === "about:blank") return location;
  const url = new URL(location);
  url.searchParams.set("device", label);
  return url.toString();
};

class ChromeTab {
  #resumeLocation: string | undefined;

  constructor(
    readonly connection: CdpConnection,
    readonly label: string,
  ) {}

  private evaluate = <A>(expression: string, schema: Schema.Decoder<A>) =>
    this.connection
      .command(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        RuntimeEvaluationSchema,
      )
      .pipe(
        Effect.flatMap((evaluation) => Schema.decodeUnknownEffect(schema)(evaluation.result.value)),
        Effect.mapError(
          (cause) => new ReferenceBrowserError({ operation: `evaluate tab ${this.label}`, cause }),
        ),
      );

  navigate = (location: string) => {
    const target = withDevice(location, this.label);
    if (target !== "about:blank") this.#resumeLocation = target;
    return this.connection
      .command("Page.navigate", { url: target }, EmptyObject)
      .pipe(Effect.asVoid);
  };

  waitForText = (text: string) => {
    return Effect.gen({ self: this }, function* () {
      let body = "";
      for (let attempt = 0; attempt < 200; attempt += 1) {
        body = yield* this.evaluate("document.body?.textContent ?? ''", Schema.String);
        if (body.includes(text)) return;
        yield* Effect.sleep(25);
      }
      return yield* new ReferenceBrowserError({
        operation: `wait for ${JSON.stringify(text)} in tab ${this.label}: ${body}`,
      });
    });
  };

  readProjection = (threadId: string) =>
    this.evaluate(
      `sessionStorage.getItem(${JSON.stringify(`osfo.thread-projection.v1.${threadId}`)})`,
      Schema.NullOr(Schema.String),
    ).pipe(
      Effect.flatMap((encoded) =>
        encoded === null
          ? Effect.succeed(undefined)
          : Schema.decodeUnknownEffect(ThreadSnapshotFromJson)(encoded).pipe(
              Effect.mapError(
                (cause) =>
                  new ReferenceBrowserError({
                    operation: `decode projection in tab ${this.label}`,
                    cause,
                  }),
              ),
            ),
      ),
    );

  readRequiredProjection = (threadId: string) =>
    this.readProjection(threadId).pipe(
      Effect.flatMap((projection) =>
        projection === undefined
          ? Effect.fail(
              new ReferenceBrowserError({ operation: `read projection in tab ${this.label}` }),
            )
          : Effect.succeed(projection),
      ),
    );

  waitForProjection = (threadId: string, position: string) => {
    return Effect.gen({ self: this }, function* () {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const projection = yield* this.readProjection(threadId);
        if (projection?.throughPosition === position) return projection;
        yield* Effect.sleep(25);
      }
      return yield* new ReferenceBrowserError({
        operation: `wait for position ${position} in tab ${this.label}`,
      });
    });
  };

  disconnect = () => this.navigate("about:blank");

  resume = () =>
    this.#resumeLocation === undefined
      ? Effect.fail(new ReferenceBrowserError({ operation: `resume tab ${this.label}` }))
      : this.navigate(this.#resumeLocation);

  location = () => this.evaluate("globalThis.location.href", Schema.String);

  submitMessage = (content: string) => {
    return Effect.gen({ self: this }, function* () {
      yield* this.evaluate("document.querySelector('#thread-message')?.focus()", Schema.Undefined);
      yield* this.connection
        .command("Input.insertText", { text: content }, EmptyObject)
        .pipe(Effect.asVoid);
      yield* this.evaluate(
        "document.querySelector('button[aria-label=\"Send message\"]')?.click()",
        Schema.Undefined,
      );
      const requestId = yield* waitForDefined(
        `wait for Acceptance Receipt in tab ${this.label}`,
        this.connection.takeCompletedMessage,
      );
      const response = yield* this.connection.command(
        "Network.getResponseBody",
        { requestId },
        ResponseBodySchema,
      );
      if (response.base64Encoded) {
        return yield* new ReferenceBrowserError({
          operation: `decode base64 Acceptance Receipt in tab ${this.label}`,
        });
      }
      return yield* Schema.decodeUnknownEffect(AcceptanceReceiptFromJson)(response.body).pipe(
        Effect.mapError(
          (cause) => new ReferenceBrowserError({ operation: "decode Acceptance Receipt", cause }),
        ),
      );
    });
  };

  eventRequestCount = () => this.connection.eventRequestCount;

  waitForEventRequestAfter = (count: number) =>
    waitFor(
      `wait for tab ${this.label} to resume its event stream`,
      this.connection.eventRequestCount,
      (current) => current > count,
    ).pipe(Effect.asVoid);
}

const findChrome = Effect.gen(function* () {
  for (const candidate of chromeCandidates) {
    const exists = yield* Effect.tryPromise({
      try: () => access(candidate).then(() => true),
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (exists) return candidate;
  }
  return yield* new ReferenceBrowserError({ operation: "find Google Chrome" });
});

export const startGoogleChrome = () =>
  Effect.gen(function* () {
    const port = yield* availablePort;
    const userDataDirectory = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "osfo-reference-chrome-")),
      catch: (cause) =>
        new ReferenceBrowserError({ operation: "create Chrome user data directory", cause }),
    });
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        try: () => rm(userDataDirectory, { recursive: true, force: true }),
        catch: (cause) =>
          new ReferenceBrowserError({ operation: "remove Chrome user data directory", cause }),
      }).pipe(Effect.ignore),
    );
    const chrome = yield* findChrome;
    yield* ChildProcess.make(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        `--remote-debugging-port=${port}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${userDataDirectory}`,
        "about:blank",
      ],
      { stdin: "ignore", forceKillAfter: "3 seconds" },
    ).pipe(
      Effect.mapError(
        (cause) => new ReferenceBrowserError({ operation: "start Google Chrome", cause }),
      ),
    );
    const debuggingOrigin = `http://127.0.0.1:${port}`;
    yield* waitForHttp(`${debuggingOrigin}/json/version`);
    const client = yield* HttpClient.HttpClient;

    const openTab = (location: string, label: string) =>
      Effect.gen(function* () {
        const response = yield* client.execute(
          HttpClientRequest.put(`${debuggingOrigin}/json/new?${encodeURIComponent("about:blank")}`),
        );
        const target = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ChromeTargetSchema)),
          Effect.mapError(
            (cause) => new ReferenceBrowserError({ operation: `open Chrome tab ${label}`, cause }),
          ),
        );
        const connection = yield* CdpConnection.connect(target.webSocketDebuggerUrl, label);
        yield* Effect.addFinalizer(() => connection.close);
        yield* connection.command("Page.enable", {}, EmptyObject);
        yield* connection.command("Runtime.enable", {}, EmptyObject);
        yield* connection.command("Network.enable", {}, EmptyObject);
        const tab = new ChromeTab(connection, label);
        if (location !== "about:blank") yield* tab.navigate(location);
        return tab;
      });

    return { openTab };
  }).pipe(Effect.provide(NodeServices.layer));
