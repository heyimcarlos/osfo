/* oxlint-disable effecttsgo/async-function -- throwaway S0 spike, plain async test bodies are intentional */
import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("injects the database identity into the HTTP leg", async () => {
  const response = await exports.default.fetch(new Request("https://osfo.test/env"));
  const body: { marker: string; db: string } = await response.json();
  expect(body.db).toContain("postgres://osfo:osfo@127.0.0.1:5432");
  expect(body.marker).not.toBe("missing");
});

it("reads the identical database identity inside the DO leg", async () => {
  const response = await exports.default.fetch(new Request("https://osfo.test/do/env"));
  const body: { connectionString: string; marker: string } = await response.json();
  expect(body.connectionString).toContain("postgres://osfo:osfo@127.0.0.1:5432");
  expect(body.marker).not.toBe("missing");
});

it("runs postgres.js against real Postgres inside the runtime", async () => {
  const response = await exports.default.fetch(new Request("https://osfo.test/query"));
  const body: { ok: boolean } = await response.json();
  expect(body.ok).toBe(true);
});
