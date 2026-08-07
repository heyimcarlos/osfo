import { PgClient } from "@effect/sql-pg";
import { AcceptanceReceipt } from "@osfo/api";
import { CommitUnknown, submitThreadMessage } from "@osfo/api/client";
import { seedReferenceClientAuthority } from "@osfo/db/reference-client";
import { prepareMessageAdmissionFixture, readMessageAuthorityCounts } from "@osfo/db/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { startCompiledIngress } from "../src/testing.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const authenticationToken = "browser-composition-session";

describe("Osfo ingress composition", () => {
  it.live("accepts one authenticated Thread message durably", () =>
    Effect.gen(function* () {
      yield* prepareMessageAdmissionFixture(databaseUrl, { principals: [] });
      yield* seedReferenceClientAuthority({ authenticationToken, databaseUrl, threadId });
      yield* seedReferenceClientAuthority({ authenticationToken, databaseUrl, threadId });

      const ingress = yield* startCompiledIngress({
        databaseUrl,
        executionProfileRef: "oz.composition-test.v1",
      });

      const idempotencyKey = crypto.randomUUID();
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(`${ingress.origin}/v1/threads/${threadId}/messages`).pipe(
          HttpClientRequest.bearerToken(authenticationToken),
          HttpClientRequest.bodyJsonUnsafe({
            protocolVersion: 1,
            idempotencyKey,
            message: { content: "Hello through HTTP" },
          }),
        ),
      );

      expect(response.status).toBe(200);
      const acceptedBody = yield* response.json;
      expect(acceptedBody).toMatchObject({
        protocolVersion: 1,
        idempotencyKey,
        threadId,
        threadPosition: "1",
      });
      const accepted = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ agentRunId: Schema.String.check(Schema.isUUID()) }),
      )(acceptedBody);

      const reconciled = yield* readMessageAuthorityCounts(databaseUrl);
      expect(reconciled).toEqual({ receipts: "1", messages: "1", runs: "1", outbox: "1" });

      const snapshotResponse = yield* client.execute(
        HttpClientRequest.get(`${ingress.origin}/v1/threads/${threadId}/snapshot`).pipe(
          HttpClientRequest.bearerToken(authenticationToken),
        ),
      );
      expect(snapshotResponse.status).toBe(200);
      expect(yield* snapshotResponse.json).toMatchObject({
        throughPosition: "1",
        timeline: [
          {
            type: "userMessage",
            content: [{ type: "text", text: "Hello through HTTP" }],
          },
        ],
      });

      const cancellationResponse = yield* client.execute(
        HttpClientRequest.post(
          `${ingress.origin}/v1/threads/${threadId}/agent-runs/${accepted.agentRunId}/cancellation`,
        ).pipe(
          HttpClientRequest.bearerToken(authenticationToken),
          HttpClientRequest.bodyJsonUnsafe({ protocolVersion: 1 }),
        ),
      );
      expect(cancellationResponse.status).toBe(200);
      expect(yield* cancellationResponse.json).toEqual({
        protocolVersion: 1,
        agentRunId: accepted.agentRunId,
        outcome: "canceled",
      });

      const canceledSnapshotResponse = yield* client.execute(
        HttpClientRequest.get(`${ingress.origin}/v1/threads/${threadId}/snapshot`).pipe(
          HttpClientRequest.bearerToken(authenticationToken),
        ),
      );
      expect(canceledSnapshotResponse.status).toBe(200);
      expect(yield* canceledSnapshotResponse.json).toMatchObject({
        throughPosition: "3",
        activeState: [],
      });
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.live("reconciles two ambiguous HTTP responses from the durable PostgreSQL receipt", () =>
    Effect.gen(function* () {
      yield* prepareMessageAdmissionFixture(databaseUrl, { principals: [] });
      yield* seedReferenceClientAuthority({ authenticationToken, databaseUrl, threadId });
      const ingress = yield* startCompiledIngress({
        databaseUrl,
        executionProfileRef: "oz.composition-test.v1",
      });

      const network = yield* HttpClient.HttpClient;
      let ambiguousResponses = 0;
      const ambiguousHttp = Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((request) =>
          network.execute(request).pipe(
            Effect.map((response) => {
              if (
                request.url.endsWith(`/v1/threads/${threadId}/messages`) &&
                ambiguousResponses < 2
              ) {
                ambiguousResponses += 1;
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ accepted: true }, { status: response.status }),
                );
              }
              return response;
            }),
          ),
        ),
      );
      const idempotencyKey = crypto.randomUUID();
      const receipt = yield* submitThreadMessage({
        baseUrl: ingress.origin,
        authenticationToken,
        threadId,
        idempotencyKey,
        message: { content: "Repeated ambiguity" },
        httpClientLayer: ambiguousHttp,
      });

      expect(receipt).toMatchObject({ idempotencyKey, threadId });
      expect(ambiguousResponses).toBe(2);
      expect(yield* readMessageAuthorityCounts(databaseUrl)).toEqual({
        receipts: "1",
        messages: "1",
        runs: "1",
        outbox: "1",
      });
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.live("recovers leaked process capacity automatically and admits new work", () =>
    Effect.gen(function* () {
      yield* prepareMessageAdmissionFixture(databaseUrl, { principals: [] });
      yield* seedReferenceClientAuthority({ authenticationToken, databaseUrl, threadId });
      const ingress = yield* startCompiledIngress({
        admissionCapacityReconciliationIntervalMs: 50,
        databaseUrl,
        executionProfileRef: "oz.composition-test.v1",
        globalNonTerminalLimit: 1,
        principalNonTerminalLimit: 1,
      });
      const client = yield* HttpClient.HttpClient;
      const submit = (idempotencyKey: string, content: string) =>
        client.execute(
          HttpClientRequest.post(`${ingress.origin}/v1/threads/${threadId}/messages`).pipe(
            HttpClientRequest.bearerToken(authenticationToken),
            HttpClientRequest.bodyJsonUnsafe({
              protocolVersion: 1,
              idempotencyKey,
              message: { content },
            }),
          ),
        );

      const first = yield* submit(crypto.randomUUID(), "Before process loss");
      expect(first.status).toBe(200);
      const firstReceipt = yield* Schema.decodeUnknownEffect(AcceptanceReceipt)(yield* first.json);
      const sql = yield* PgClient.PgClient;
      yield* sql`UPDATE agent_runs SET state = 'succeeded'
        WHERE agent_run_id = ${firstReceipt.agentRunId}::uuid`;

      const recoveryKey = crypto.randomUUID();
      let recoveryStatus = 429;
      for (let attempt = 0; attempt < 20 && recoveryStatus !== 200; attempt += 1) {
        const response = yield* submit(recoveryKey, "After automatic recovery");
        recoveryStatus = response.status;
        if (recoveryStatus !== 200) yield* Effect.sleep(25);
      }

      expect(recoveryStatus).toBe(200);
      expect(yield* readMessageAuthorityCounts(databaseUrl)).toEqual({
        receipts: "2",
        messages: "2",
        runs: "2",
        outbox: "2",
      });
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(
        PgClient.layer({
          applicationName: "osfo-ingress-recovery-test",
          maxConnections: 1,
          url: Redacted.make(databaseUrl),
        }),
      ),
    ),
  );

  it.live("preserves unknown after acceptance when authentication is revoked", () =>
    Effect.gen(function* () {
      yield* prepareMessageAdmissionFixture(databaseUrl, { principals: [] });
      yield* seedReferenceClientAuthority({ authenticationToken, databaseUrl, threadId });
      const ingress = yield* startCompiledIngress({
        databaseUrl,
        executionProfileRef: "oz.composition-test.v1",
      });
      const network = yield* HttpClient.HttpClient;
      const sql = yield* PgClient.PgClient;
      let firstSubmission = true;
      const revokedAfterAcceptance = Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((request) =>
          network.execute(request).pipe(
            Effect.flatMap((response) => {
              if (firstSubmission && request.url.endsWith(`/v1/threads/${threadId}/messages`)) {
                firstSubmission = false;
                return sql`UPDATE authentication_sessions
                    SET revoked_at = transaction_timestamp()`.pipe(
                  Effect.orDie,
                  Effect.as(
                    HttpClientResponse.fromWeb(
                      request,
                      Response.json({ accepted: true }, { status: response.status }),
                    ),
                  ),
                );
              }
              return Effect.succeed(response);
            }),
          ),
        ),
      );

      const error = yield* Effect.flip(
        submitThreadMessage({
          baseUrl: ingress.origin,
          authenticationToken,
          threadId,
          idempotencyKey: crypto.randomUUID(),
          message: { content: "Accepted before revocation" },
          httpClientLayer: revokedAfterAcceptance,
        }),
      );

      expect(error).toEqual(new CommitUnknown());
      expect(yield* readMessageAuthorityCounts(databaseUrl)).toEqual({
        receipts: "1",
        messages: "1",
        runs: "1",
        outbox: "1",
      });
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(
        PgClient.layer({
          applicationName: "osfo-ingress-revocation-test",
          maxConnections: 1,
          url: Redacted.make(databaseUrl),
        }),
      ),
    ),
  );
});
