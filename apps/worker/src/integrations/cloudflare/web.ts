import { Effect, Schema } from "effect";

import { ManagedSearchEvidence } from "../../domain/web-search-evidence";

import {
  canonicalPublicUrl,
  isSafePublicUrl,
  limits,
  type DiscoveryResult,
  type PageFetch,
} from "../../services/web";

const providerText = (maximumLength: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumLength));

const DiscoveryResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      description: Schema.optionalKey(providerText(10_000)),
      lastModifiedDate: Schema.optionalKey(providerText(100)),
      title: providerText(2_000),
      url: providerText(4_096),
    }),
  ).check(Schema.isMaxLength(limits.resultsPerSearch)),
  metadata: Schema.Struct({
    latencyMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    query: providerText(limits.queryCharacters),
    requestId: providerText(512),
  }),
});

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit<RequestInitCfProperties>,
) => Promise<Response>;

type SearchBinding = Pick<WebSearch, "search">;

/**
 * Activation remains fail-closed until Cloudflare publishes a traceable
 * standalone WebSearch price or explicitly classifies it as zero marginal
 * cost. Wrangler 4.127 only states that remote use may incur charges.
 */
export const hasRecognizedWebSearchPrice = false;

export class WebProviderUnavailable extends Schema.TaggedError<WebProviderUnavailable>()(
  "WebProviderUnavailable",
  {
    managedSearch: Schema.optionalKey(ManagedSearchEvidence),
    message: Schema.String,
    operation: Schema.Literals(["discover", "fetch", "readBody", "redirect"]),
    retry: Schema.Literals(["ambiguous", "never", "transient"]),
  },
) {}

/** Adapt the permission-bearing Cloudflare Web Search binding once. */
export const makeDiscovery = (binding: SearchBinding) =>
  Effect.fn("CloudflareWeb.discover")(function* (query: string, limit: number) {
    const response = yield* Effect.tryPromise({
      try: () => binding.search({ limit, query }),
      catch: () =>
        providerUnavailable(
          "discover",
          "Public-web discovery acceptance is ambiguous.",
          "ambiguous",
        ),
    });
    const decoded = yield* Schema.decodeEffect(DiscoveryResponse)(response).pipe(
      Effect.mapError(() =>
        providerUnavailable("discover", "Public-web discovery returned an invalid response."),
      ),
    );
    if (decoded.metadata.query !== query) {
      return yield* providerUnavailable(
        "discover",
        "Public-web discovery returned evidence for a different query.",
      );
    }
    return {
      evidence: {
        latencyMs: decoded.metadata.latencyMs,
        requestId: decoded.metadata.requestId,
      },
      results: decoded.items,
    } satisfies DiscoveryResult;
  });

/** Fetch one public page with explicit redirect and retained-byte bounds. */
export const makePageFetch = (fetcher: Fetcher = fetch) =>
  Effect.fn("CloudflareWeb.fetchPage")(function* (input: { readonly url: string }) {
    let currentUrl = input.url;
    const redirects: Array<string> = [];
    let response: Response | undefined;
    for (let hop = 0; hop <= limits.redirects; hop += 1) {
      if (!isSafePublicUrl(currentUrl)) {
        return yield* providerUnavailable("redirect", "The page redirect target is unsafe.");
      }
      currentUrl = canonicalPublicUrl(currentUrl);
      response = yield* Effect.tryPromise({
        try: () =>
          fetcher(currentUrl, {
            headers: {
              accept: "text/html, application/xhtml+xml, text/plain, text/markdown;q=0.9",
              "user-agent": "Osfo/1.0 (+https://osfo.dev)",
            },
            redirect: "manual",
            signal: AbortSignal.timeout(limits.providerDeadlineMilliseconds),
          }),
        catch: () =>
          providerUnavailable("fetch", "The public page could not be fetched.", "transient"),
      });
      if (!redirectStatus(response.status)) break;
      const location = response.headers.get("location");
      if (location === null || hop === limits.redirects) {
        return yield* providerUnavailable("redirect", "The page redirect limit was exceeded.");
      }
      const target = new URL(location, currentUrl).href;
      if (!isSafePublicUrl(target)) {
        return yield* providerUnavailable("redirect", "The page redirect target is unsafe.");
      }
      const canonicalTarget = canonicalPublicUrl(target);
      redirects.push(canonicalTarget);
      currentUrl = canonicalTarget;
    }
    if (response === undefined) {
      return yield* providerUnavailable("fetch", "The public page could not be fetched.");
    }
    const contentType = boundedHeader(
      response.headers.get("content-type") ?? "application/octet-stream",
      512,
    );
    const declaredLength = boundedContentLength(response.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > limits.fetchedPageBytes) {
      yield* Effect.promise(
        () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
      );
      return oversizedPage(response, currentUrl, redirects, contentType);
    }
    const body = yield* readBoundedBody(response);
    if (body.oversized) return oversizedPage(response, currentUrl, redirects, contentType);
    const source = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(body.bytes);
    const normalized = normalizePage(source, contentType);
    const normalizedBytes = BigInt(new TextEncoder().encode(normalized.content).byteLength);
    if (normalizedBytes > limits.normalizedPageBytes) {
      return {
        ...basePage(response, currentUrl, redirects, contentType),
        content: "",
        fetchedBytes: BigInt(body.bytes.byteLength),
        normalizedBytes,
        title: normalized.title,
      } satisfies PageFetch;
    }
    return {
      ...basePage(response, currentUrl, redirects, contentType),
      content: normalized.content,
      fetchedBytes: BigInt(body.bytes.byteLength),
      normalizedBytes,
      title: normalized.title,
    } satisfies PageFetch;
  });

const readBoundedBody = (response: Response) =>
  Effect.tryPromise({
    // oxlint-disable-next-line effecttsgo/async-function -- Stream chunks are an ordered Promise boundary.
    try: async () => {
      if (response.body === null) return { bytes: new Uint8Array(), oversized: false };
      const reader = response.body.getReader();
      const chunks: Array<Uint8Array> = [];
      let byteLength = 0;
      while (true) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Response chunks must be consumed in order.
        const next = await reader.read();
        if (next.done) break;
        if (byteLength + next.value.byteLength > Number(limits.fetchedPageBytes)) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Stop the same response stream before returning.
          await reader.cancel();
          return { bytes: new Uint8Array(), oversized: true };
        }
        chunks.push(next.value);
        byteLength += next.value.byteLength;
      }
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { bytes, oversized: false };
    },
    catch: () =>
      providerUnavailable("readBody", "The public page body could not be read.", "transient"),
  });

const normalizePage = (source: string, contentType: string) => {
  if (!contentType.toLowerCase().includes("html")) {
    return { content: source.replaceAll(/\s+/gu, " ").trim(), title: null };
  }
  const titleMatch = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/iu.exec(source);
  const title =
    titleMatch === null
      ? null
      : decodeEntities(stripTags(titleMatch[1] ?? ""))
          .replaceAll(/\s+/gu, " ")
          .trim()
          .slice(0, 2_000);
  const visible = source
    .replaceAll(/<!--([\s\S]*?)-->/gu, " ")
    .replaceAll(
      /<(?:script|style|noscript|template|svg|canvas|form)(?:\s[^>]*)?>[\s\S]*?<\/(?:script|style|noscript|template|svg|canvas|form)>/giu,
      " ",
    );
  return {
    content: decodeEntities(stripTags(visible)).replaceAll(/\s+/gu, " ").trim(),
    title: title === "" ? null : title,
  };
};

const stripTags = (value: string) => value.replaceAll(/<[^>]*>/gu, " ");

const decodeEntities = (value: string) =>
  value.replaceAll(/&(?:amp|apos|gt|lt|nbsp|quot|#\d+|#x[\da-f]+);/giu, (entity) => {
    const lower = entity.toLowerCase();
    const known = namedEntities.get(lower);
    if (known !== undefined) return known;
    const hexadecimal = lower.startsWith("&#x");
    const parsed = Number.parseInt(lower.slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0x10_ffff
      ? String.fromCodePoint(parsed)
      : " ";
  });

const namedEntities = new Map([
  ["&amp;", "&"],
  ["&apos;", "'"],
  ["&gt;", ">"],
  ["&lt;", "<"],
  ["&nbsp;", " "],
  ["&quot;", '"'],
]);

const boundedContentLength = (value: string | null): bigint | null => {
  if (value === null || !/^\d+$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

const boundedHeader = (value: string, maximum: number) =>
  value
    .replaceAll(/[\r\n]/gu, " ")
    .trim()
    .slice(0, maximum) || "application/octet-stream";

const basePage = (
  response: Response,
  finalUrl: string,
  redirects: ReadonlyArray<string>,
  contentType: string,
) => ({ contentType, finalUrl, redirects, status: response.status });

const oversizedPage = (
  response: Response,
  finalUrl: string,
  redirects: ReadonlyArray<string>,
  contentType: string,
): PageFetch => ({
  ...basePage(response, finalUrl, redirects, contentType),
  content: "",
  fetchedBytes: limits.fetchedPageBytes + 1n,
  normalizedBytes: 0n,
  title: null,
});

const redirectStatus = (status: number) =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

const providerUnavailable = (
  operation: WebProviderUnavailable["operation"],
  message: string,
  retry: WebProviderUnavailable["retry"] = "never",
) => new WebProviderUnavailable({ message, operation, retry });
