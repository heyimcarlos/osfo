import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ThinkSubmissionId, UserId } from "../../domain";
import { executeWebSearch, makeWebTools } from "./web-tools";

/* oxlint-disable effecttsgo/async-function -- These tests exercise the AI SDK Promise Tool boundary. */

const activeTurn = {
  authorityIdentity: { userId: UserId.make("user-1") },
  submissionId: ThinkSubmissionId.make("turn-1"),
};

it("keeps public-web I/O dormant until an active model tool call", async () => {
  let searches = 0;
  const dependencies = {
    readActiveTurn: () => undefined,
    readRequestText: () => "Search the web for Osfo",
    web: {
      readPage: () => Effect.die(new Error("unexpected page read")),
      search: () => {
        searches += 1;
        return Effect.die(new Error("unexpected search"));
      },
    },
  };
  const tools = makeWebTools(dependencies);

  expect(tools).toHaveProperty("webSearch");
  expect(tools).toHaveProperty("readWebPage");
  expect(searches).toBe(0);
  const result = await executeWebSearch(dependencies, { query: "Osfo" }, "search-1");
  expect(result).toMatchObject({ _tag: "WebToolUnavailable" });
  expect(searches).toBe(0);
});

it("passes the current User request and durable turn identity to the deep Web service", async () => {
  let received: unknown;
  const result = await executeWebSearch(
    {
      readActiveTurn: () => activeTurn,
      readRequestText: () => "Search the web for Osfo",
      web: {
        readPage: () => Effect.die(new Error("unexpected page read")),
        search: (input) => {
          received = input;
          return Effect.succeed({
            _tag: "SearchCompleted" as const,
            guidance: "cite pages",
            providerEvidence: { latencyMs: 1, requestId: "request-1" },
            query: input.query,
            resultSetId: "set-1",
            results: [],
          });
        },
      },
    },
    { query: "Osfo" },
    "search-1",
  );

  expect(result).toMatchObject({ _tag: "SearchCompleted" });
  expect(received).toMatchObject({
    operationId: "search-1",
    query: "Osfo",
    requestText: "Search the web for Osfo",
    turnId: "turn-1",
    userId: "user-1",
  });
});
