/* oxlint-disable effecttsgo/async-function -- The Node HTTP observer and fetch client are Promise boundaries owned by this test. */
/* oxlint-disable effecttsgo/global-fetch -- This Node-only contract test calls its run-owned local HTTP observer directly. */
/* oxlint-disable osfo/no-unknown-parameters -- The test client intentionally sends malformed unknown JSON to the observer trust boundary. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import {
  type DatabaseObserver,
  type DatabaseObserverAccountDeletionMutations,
  startDatabaseObserver,
} from "./database-observer";

const expired: Array<{ readonly actionId: string; readonly userId: string }> = [];
const versioned: Array<{
  readonly actionId: string;
  readonly presentationVersion: string;
  readonly userId: string;
}> = [];
const mutations: DatabaseObserverAccountDeletionMutations = {
  expire: (input) => {
    expired.push(input);
    return Promise.resolve();
  },
  version: (input) => {
    versioned.push(input);
    return Promise.resolve();
  },
};
let observer: DatabaseObserver;

beforeAll(async () => {
  observer = await startDatabaseObserver({
    accountDeletionMutations: mutations,
    databaseNamePrefix: "observer-test-",
    maintenanceUrl: "postgres://unused:unused@127.0.0.1:1/unused",
  });
});

afterAll(async () => {
  await observer.close();
});

beforeEach(() => {
  expired.length = 0;
  versioned.length = 0;
});

describe("database observer request boundary", () => {
  it.each([
    ["null", null],
    ["empty object", {}],
    ["array", []],
    ["number", 42],
    ["null User", { actionId: "action-1", userId: null }],
    ["numeric Action", { actionId: 7, userId: "user-1" }],
    ["blank Action", { actionId: "", userId: "user-1" }],
    ["blank User", { actionId: "action-1", userId: "" }],
  ])("rejects malformed expire input %s before mutation", async (_name, body) => {
    const response = await post("/expire-account-deletion-action", body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(expired).toEqual([]);
    expect(versioned).toEqual([]);
  });

  it.each([
    ["null", null],
    ["object", {}],
    ["array", []],
    ["number", 42],
    ["numeric version", { actionId: "action-1", presentationVersion: 2, userId: "user-1" }],
    ["blank version", { actionId: "action-1", presentationVersion: "", userId: "user-1" }],
    ["blank Action", { actionId: "", presentationVersion: "v1", userId: "user-1" }],
    ["blank User", { actionId: "action-1", presentationVersion: "v1", userId: "" }],
  ])("rejects malformed version input %s before mutation", async (_name, body) => {
    const response = await post("/version-account-deletion-action", body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(expired).toEqual([]);
    expect(versioned).toEqual([]);
  });

  it.each([null, {}, [], 42, { userId: "" }, { userId: 7 }])(
    "rejects malformed observation input before database access",
    async (body) => {
      const response = await post("/registration", body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request body" });
      expect(expired).toEqual([]);
      expect(versioned).toEqual([]);
    },
  );

  it("accepts exact nonempty Action mutation shapes", async () => {
    const expiredResponse = await post("/expire-account-deletion-action", {
      actionId: "action-1",
      userId: "user-1",
    });
    const versionedResponse = await post("/version-account-deletion-action", {
      actionId: "action-2",
      presentationVersion: "account-deletion-v2",
      userId: "user-2",
    });

    expect(expiredResponse.status).toBe(200);
    expect(versionedResponse.status).toBe(200);
    expect(expired).toEqual([{ actionId: "action-1", userId: "user-1" }]);
    expect(versioned).toEqual([
      {
        actionId: "action-2",
        presentationVersion: "account-deletion-v2",
        userId: "user-2",
      },
    ]);
  });
});

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${observer.origin}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
