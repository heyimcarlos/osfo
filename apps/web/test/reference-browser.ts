import { NodeServices } from "@effect/platform-node";
import { AcceptanceReceipt } from "@osfo/api";
import { ThreadSnapshotSchema } from "@osfo/session";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
const ScreenshotSchema = Schema.Struct({ data: Schema.String });
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
const observeVisibleText = `(() => {
  const observed = [];
  Object.defineProperty(globalThis, "__osfoObservedText", { value: observed });
  const record = () => {
    const text = document.body?.textContent;
    if (text !== undefined && observed.at(-1) !== text) {
      observed.push(text);
      if (observed.length > 100) observed.shift();
    }
  };
  const start = () => {
    record();
    new MutationObserver(record).observe(document.body, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})()`;
const redactEvidenceIdentifiers = `(() => {
  const redact = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) !== null) {
      const value = node.nodeValue;
      if (value !== null) {
        const redacted = value.replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
          "redacted reference ID",
        );
        if (redacted !== value) node.nodeValue = redacted;
      }
    }
    if (document.querySelector("[data-osfo-evidence-scope]") === null) {
      const badge = document.createElement("div");
      badge.dataset.osfoEvidenceScope = "true";
      badge.textContent =
        "Local PostgreSQL journey · stable identifiers redacted · independent resume only";
      Object.assign(badge.style, {
        background: "#16233a",
        bottom: "0",
        color: "white",
        font: "600 11px system-ui, sans-serif",
        left: "0",
        padding: "6px 10px",
        position: "fixed",
        right: "0",
        textAlign: "center",
        zIndex: "2147483647",
      });
      document.body.append(badge);
    }
  };
  const start = () => {
    redact();
    new MutationObserver(redact).observe(document.body, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})()`;

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
  readonly #completedMessages: Array<{ readonly requestId: string; readonly status: number }> = [];
  readonly #eventRequests: Array<{ readonly requestId: string; readonly url: string }> = [];
  readonly #eventResponses = new Map<string, number>();
  readonly #pending = new Map<number, PendingCommand>();
  readonly #requests = new Map<string, { readonly method: string; readonly url: string }>();
  readonly #messageResponses = new Map<string, number>();
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
          this.#eventRequests.push({
            requestId: request.value.requestId,
            url: request.value.request.url,
          });
        }
      }
    }
    if (message.method === "Network.responseReceived") {
      const response = Schema.decodeUnknownOption(ResponseReceivedSchema)(message.params);
      if (Option.isSome(response)) {
        const request = this.#requests.get(response.value.requestId);
        if (request !== undefined && new URL(request.url).pathname.endsWith("/events")) {
          this.#eventResponses.set(response.value.requestId, response.value.response.status);
        }
        if (request?.method === "POST" && new URL(request.url).pathname.endsWith("/messages")) {
          this.#messageResponses.set(response.value.requestId, response.value.response.status);
        }
      }
    }
    if (message.method === "Network.loadingFinished") {
      const completed = Schema.decodeUnknownOption(LoadingFinishedSchema)(message.params);
      if (Option.isSome(completed) && this.#messageResponses.has(completed.value.requestId)) {
        this.#completedMessages.push({
          requestId: completed.value.requestId,
          status: this.#messageResponses.get(completed.value.requestId)!,
        });
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
  eventRequestAt = (index: number) => Effect.sync(() => this.#eventRequests[index]?.url);
  eventResponseAt = (index: number) =>
    Effect.sync(() => {
      const request = this.#eventRequests[index];
      if (request === undefined) return undefined;
      const status = this.#eventResponses.get(request.requestId);
      return status === undefined ? undefined : { status, url: request.url };
    });

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
        body = yield* this.evaluate(
          "(() => { const current = document.body?.textContent ?? ''; const observed = globalThis.__osfoObservedText; return Array.isArray(observed) ? `${current}\\n${observed.join('\\n')}` : current; })()",
          Schema.String,
        );
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

  configureEvidenceViewport = (width: number, height: number) =>
    Effect.gen({ self: this }, function* () {
      yield* this.connection.command(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: redactEvidenceIdentifiers },
        EmptyObject,
      );
      yield* this.connection.command(
        "Runtime.evaluate",
        { expression: redactEvidenceIdentifiers },
        RuntimeEvaluationSchema,
      );
      yield* this.connection.command(
        "Emulation.setDeviceMetricsOverride",
        { deviceScaleFactor: 1, height, mobile: false, width },
        EmptyObject,
      );
    });

  captureEvidenceFrame = () =>
    this.connection
      .command(
        "Page.captureScreenshot",
        { captureBeyondViewport: false, format: "png", fromSurface: true },
        ScreenshotSchema,
      )
      .pipe(Effect.map(({ data }) => Buffer.from(data, "base64")));

  submitMessage = (content: string) => {
    return Effect.gen({ self: this }, function* () {
      yield* this.evaluate("document.querySelector('#thread-message')?.focus()", Schema.Undefined);
      yield* this.connection
        .command("Input.insertText", { text: content }, EmptyObject)
        .pipe(Effect.asVoid);
      yield* waitFor(
        `wait for message submission in tab ${this.label}`,
        this.evaluate(
          "document.querySelector('button[aria-label=\"Send message\"]')?.disabled ?? true",
          Schema.Boolean,
        ),
        (disabled) => !disabled,
      );
      yield* this.connection
        .command(
          "Input.dispatchKeyEvent",
          { code: "Enter", key: "Enter", type: "rawKeyDown", windowsVirtualKeyCode: 13 },
          EmptyObject,
        )
        .pipe(Effect.asVoid);
      yield* this.connection
        .command(
          "Input.dispatchKeyEvent",
          { code: "Enter", key: "Enter", type: "keyUp", windowsVirtualKeyCode: 13 },
          EmptyObject,
        )
        .pipe(Effect.asVoid);
      const completed = yield* waitForDefined(
        `wait for Acceptance Receipt in tab ${this.label}`,
        this.connection.takeCompletedMessage,
      );
      const response = yield* this.connection.command(
        "Network.getResponseBody",
        { requestId: completed.requestId },
        ResponseBodySchema,
      );
      if (response.base64Encoded) {
        return yield* new ReferenceBrowserError({
          operation: `decode base64 Acceptance Receipt in tab ${this.label}`,
        });
      }
      if (completed.status !== 200) {
        return yield* new ReferenceBrowserError({
          operation: `submit message in tab ${this.label} returned ${completed.status}: ${response.body}`,
        });
      }
      yield* waitFor(
        `wait for message composer to clear in tab ${this.label}`,
        this.evaluate(
          "document.querySelector('#thread-message')?.value ?? 'missing'",
          Schema.String,
        ),
        (value) => value.length === 0,
      );
      return yield* Schema.decodeUnknownEffect(AcceptanceReceiptFromJson)(response.body).pipe(
        Effect.mapError(
          (cause) => new ReferenceBrowserError({ operation: "decode Acceptance Receipt", cause }),
        ),
      );
    });
  };

  eventRequestCount = () => this.connection.eventRequestCount;

  waitForEventRequestAfter = (count: number) =>
    waitForDefined(
      `wait for tab ${this.label} to resume its event stream`,
      this.connection.eventRequestAt(count),
    );

  waitForEventResponseAfter = (count: number) =>
    waitForDefined(
      `wait for tab ${this.label} resumed event response`,
      this.connection.eventResponseAt(count),
    );
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

const verifyGoogleChrome = (executable: string) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(executable, ["--version"], {
      stdin: "ignore",
      forceKillAfter: "3 seconds",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ReferenceBrowserError({ operation: "start Google Chrome version check", cause }),
      ),
    );
    const version = yield* collectProcessOutput(handle).pipe(
      Effect.mapError(
        (cause) => new ReferenceBrowserError({ operation: "read Google Chrome version", cause }),
      ),
    );
    const exitCode = yield* handle.exitCode.pipe(
      Effect.mapError(
        (cause) =>
          new ReferenceBrowserError({ operation: "wait for Google Chrome version", cause }),
      ),
    );
    if (exitCode !== 0 || !/^Google Chrome(?: for Testing)? /u.test(version)) {
      return yield* new ReferenceBrowserError({
        operation: `require Google Chrome binary: ${version.trim()}`,
      });
    }
  });

const waitForDevToolsActivePort = (userDataDirectory: string) =>
  Effect.gen(function* () {
    const path = join(userDataDirectory, "DevToolsActivePort");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const contents = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (contents !== undefined) {
        const [encodedPort] = contents.split("\n");
        const port = Number(encodedPort);
        if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) return port;
        return yield* new ReferenceBrowserError({
          operation: `decode Google Chrome DevToolsActivePort: ${contents.trim()}`,
        });
      }
      yield* Effect.sleep(25);
    }
    return yield* new ReferenceBrowserError({
      operation: "wait for Google Chrome DevToolsActivePort",
    });
  });

export const startGoogleChrome = () =>
  Effect.gen(function* () {
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
    yield* verifyGoogleChrome(chrome);
    const handle = yield* ChildProcess.make(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--remote-debugging-port=0",
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
    const port = yield* Effect.raceFirst(
      waitForDevToolsActivePort(userDataDirectory),
      handle.exitCode.pipe(
        Effect.flatMap((exitCode) =>
          Effect.fail(
            new ReferenceBrowserError({
              operation: `Google Chrome exited before DevTools became ready (${exitCode})`,
            }),
          ),
        ),
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
        yield* connection.command(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: observeVisibleText },
          EmptyObject,
        );
        const tab = new ChromeTab(connection, label);
        if (location !== "about:blank") yield* tab.navigate(location);
        return tab;
      });

    return { openTab };
  }).pipe(Effect.provide(NodeServices.layer));
