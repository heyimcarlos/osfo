import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "@effect/vitest";

const execFileAsync = promisify(execFile);
const verifierPath = join(process.cwd(), "observability/demo-packet-verifier.ts");
const inspectedOpenPokeRevision = "5b5f635935a64ab37884c025d70abb0ed731c094";
const walkthroughSourceReferences = [
  ["ChatRequest", "server/models/chat.py#L26-L35"],
  ["chat_send", "server/routes/chat.py#L10-L45"],
  ["handle_chat_request", "server/services/conversation/chat_handler.py#L22-L49"],
  ["POST", "web/app/api/chat/route.ts#L22-L56"],
  ["InteractionAgentRuntime.execute", "server/agents/interaction_agent/runtime.py#L65-L89"],
  ["request_chat_completion", "server/openrouter_client/client.py#L49-L82"],
  ["sendMessage", "web/app/page.tsx#L110-L190"],
  ["ConversationLog", "server/services/conversation/log.py#L19-L82"],
  ["get_conversation_log", "server/services/conversation/log.py#L214-L218"],
  ["app", "server/app.py#L49-L83"],
  ["get_active_gmail_user_id", "server/services/gmail/client.py#L18-L40"],
  ["ensureUserId", "web/components/SettingsModal.tsx#L122-L149"],
  ["WorkingMemoryLog", "server/services/conversation/summarization/working_memory_log.py#L16-L48"],
  ["TriggerStore", "server/services/triggers/store.py#L13-L68"],
  ["TriggerScheduler", "server/services/trigger_scheduler.py#L26-L116"],
  ["ExecutionBatchManager", "server/agents/execution_agent/batch_manager.py#L36-L145"],
  ["requirements", "server/requirements.txt#L1-L7"],
  ["gmail_execute_draft", "server/agents/execution_agent/tools/gmail.py#L375-L427"],
  ["_execute", "server/agents/execution_agent/tools/gmail.py#L324-L343"],
  ["execute_gmail_tool", "server/services/gmail/client.py#L466-L494"],
] as const;
const validWalkthrough = [
  "# OpenPoke v1 walkthrough",
  "",
  "## Part 3: OpenPoke architecture and next improvements",
  "",
  `Inspected OpenPoke revision: [${inspectedOpenPokeRevision}](https://github.com/shlokkhemani/openpoke/tree/${inspectedOpenPokeRevision}).`,
  ...walkthroughSourceReferences.map(
    ([symbol, path]) =>
      `[${symbol}](https://github.com/shlokkhemani/openpoke/blob/${inspectedOpenPokeRevision}/${path})`,
  ),
  "",
].join("\n");

const sha256 = (contents: string) => createHash("sha256").update(contents).digest("hex");
const createPacketRoot = () => mkdtemp(join(tmpdir(), "osfo-demo-packet-"));
const writeRawIndex = async (root: string, artifacts: ReadonlyArray<unknown>) => {
  const indexPath = join(root, "index.json");
  await writeFile(
    indexPath,
    JSON.stringify({ schemaVersion: 1, packet: "openpoke-v1-demo", artifacts }),
  );
  return indexPath;
};
const writeIndex = async (root: string, artifacts: ReadonlyArray<unknown>) => {
  await writeFile(join(root, "walkthrough.md"), validWalkthrough);
  return writeRawIndex(root, [
    ...artifacts,
    {
      id: "three-part-walkthrough",
      kind: "document",
      artifactStatus: "PASS",
      evidenceStatus: "PASS",
      path: "walkthrough.md",
      sha256: sha256(validWalkthrough),
      description: "The three-part walkthrough.",
    },
  ]);
};
const writeWalkthroughIndex = async (walkthrough: string) => {
  const root = await createPacketRoot();
  await writeFile(join(root, "walkthrough.md"), walkthrough);
  return writeRawIndex(root, [
    {
      id: "three-part-walkthrough",
      kind: "document",
      artifactStatus: "PASS",
      evidenceStatus: "PASS",
      path: "walkthrough.md",
      sha256: sha256(walkthrough),
      description: "The three-part walkthrough.",
    },
  ]);
};
const runVerifier = (...arguments_: ReadonlyArray<string>) =>
  execFileAsync("bun", [verifierPath, ...arguments_]);

describe("OpenPoke demo packet verifier CLI", () => {
  it.each([
    { name: "absent", artifacts: [] },
    {
      name: "renamed",
      artifacts: [
        {
          id: "renamed-walkthrough",
          kind: "document",
          artifactStatus: "PASS",
          evidenceStatus: "PASS",
          path: "walkthrough.md",
          sha256: sha256(validWalkthrough),
          description: "The renamed walkthrough.",
        },
      ],
    },
  ])("rejects a $name required walkthrough artifact", async ({ artifacts }) => {
    const root = await createPacketRoot();
    await writeFile(join(root, "walkthrough.md"), validWalkthrough);
    const indexPath = await writeRawIndex(root, artifacts);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr:
        "FAIL: INDEX_INVALID: required three-part-walkthrough artifact is missing or invalid\n",
    });
  });

  it("rejects the superseded uninspected OpenPoke walkthrough disclaimer", async () => {
    const walkthrough = [
      "# OpenPoke v1 walkthrough",
      "",
      "## Part 3: OpenPoke architecture and next improvements",
      "",
      "Without asserting uninspected repository details, process-local authority fails first.",
      "",
    ].join("\n");
    const indexPath = await writeWalkthroughIndex(walkthrough);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr:
        "FAIL: ARTIFACT_INVALID: three-part-walkthrough: superseded uninspected repository disclaimer\n",
    });
  });

  it("rejects an OpenPoke walkthrough without the inspected source revision", async () => {
    const walkthrough = [
      "# OpenPoke v1 walkthrough",
      "",
      "## Part 3: OpenPoke architecture and next improvements",
      "",
      "The command returns 202 before its detached task finishes.",
      "",
    ].join("\n");
    const indexPath = await writeWalkthroughIndex(walkthrough);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr:
        "FAIL: ARTIFACT_INVALID: three-part-walkthrough: inspected OpenPoke revision is missing or changed\n",
    });
  });

  it("rejects an inspected OpenPoke walkthrough without exact source references", async () => {
    const walkthrough = [
      "# OpenPoke v1 walkthrough",
      "",
      "## Part 3: OpenPoke architecture and next improvements",
      "",
      `Inspected OpenPoke revision: [${inspectedOpenPokeRevision}](https://github.com/shlokkhemani/openpoke/tree/${inspectedOpenPokeRevision}).`,
      "",
      "The command returns 202 before its detached task finishes.",
      "",
    ].join("\n");
    const indexPath = await writeWalkthroughIndex(walkthrough);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr:
        "FAIL: ARTIFACT_INVALID: three-part-walkthrough: missing exact OpenPoke source reference ChatRequest\n",
    });
  });

  it("accepts verified artifacts and explicit MISSING placeholders", async () => {
    const root = await createPacketRoot();
    const artifact = "sealed evidence\n";
    const manifest = `${sha256(artifact)}  ./artifact.txt\n`;
    await writeFile(join(root, "artifact.txt"), artifact);
    await writeFile(join(root, "SOURCE-SHA256SUMS"), manifest);
    const indexPath = await writeIndex(root, [
      {
        id: "source-manifest",
        kind: "source-manifest",
        artifactStatus: "PASS",
        evidenceStatus: "PASS",
        path: "SOURCE-SHA256SUMS",
        sha256: sha256(manifest),
        description: "The copied source manifest.",
      },
      {
        id: "sealed-run",
        kind: "post-run-render",
        artifactStatus: "PASS",
        evidenceStatus: "PASS",
        path: "artifact.txt",
        sha256: sha256(artifact),
        sourceManifestSha256: sha256(manifest),
        sourceManifestPath: "./artifact.txt",
        description: "A copied checksummed result.",
      },
      {
        id: "three-tab-recording",
        kind: "recording",
        artifactStatus: "MISSING",
        evidenceStatus: "MISSING",
        path: null,
        sha256: null,
        description: "No authenticated browser recording exists yet.",
      },
    ]);

    const result = await runVerifier(indexPath);

    expect(result.stdout).toBe("PASS: verified 3 artifacts; 1 MISSING\n");
    expect(result.stderr).toBe("");
  });

  it("rejects duplicate artifact identifiers", async () => {
    const root = await createPacketRoot();
    const artifact = "sealed evidence\n";
    await writeFile(join(root, "artifact.txt"), artifact);
    const indexedArtifact = {
      id: "sealed-run",
      kind: "sealed-run",
      artifactStatus: "PASS",
      evidenceStatus: "PASS",
      path: "artifact.txt",
      sha256: sha256(artifact),
      description: "A copied checksummed result.",
    };
    const indexPath = await writeIndex(root, [indexedArtifact, indexedArtifact]);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr: "FAIL: INDEX_INVALID: duplicate artifact id sealed-run\n",
    });
  });

  it("rejects an artifact whose source manifest is not indexed", async () => {
    const root = await createPacketRoot();
    const artifact = "sealed evidence\n";
    await writeFile(join(root, "artifact.txt"), artifact);
    const indexPath = await writeIndex(root, [
      {
        id: "sealed-run",
        kind: "sealed-run",
        artifactStatus: "PASS",
        evidenceStatus: "PASS",
        path: "artifact.txt",
        sha256: sha256(artifact),
        sourceManifestSha256: sha256("manifest not in this index"),
        sourceManifestPath: "./artifact.txt",
        description: "A copied checksummed result.",
      },
    ]);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr: "FAIL: INDEX_INVALID: sealed-run: source manifest checksum is not indexed\n",
    });
  });

  it("rejects forged linkage to an indexed non-manifest artifact", async () => {
    const root = await createPacketRoot();
    const artifact = "sealed evidence\n";
    const forgedManifest = `${sha256(artifact)}  ./artifact.txt\n`;
    await writeFile(join(root, "artifact.txt"), artifact);
    await writeFile(join(root, "forged.txt"), forgedManifest);
    const indexPath = await writeIndex(root, [
      {
        id: "forged-document",
        kind: "document",
        artifactStatus: "PASS",
        evidenceStatus: "PASS",
        path: "forged.txt",
        sha256: sha256(forgedManifest),
        description: "An ordinary document cannot stand in for a source manifest.",
      },
      {
        id: "sealed-run",
        kind: "sealed-run",
        artifactStatus: "PASS",
        evidenceStatus: "PASS",
        path: "artifact.txt",
        sha256: sha256(artifact),
        sourceManifestSha256: sha256(forgedManifest),
        sourceManifestPath: "./artifact.txt",
        description: "A copied checksummed result.",
      },
    ]);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr: "FAIL: INDEX_INVALID: sealed-run: source manifest checksum is not indexed\n",
    });
  });

  it.each([
    {
      name: "path",
      manifestEntry: (artifact: string) => `${sha256(artifact)}  ./different.txt\n`,
    },
    {
      name: "digest",
      manifestEntry: () => `${sha256("different bytes")}  ./artifact.txt\n`,
    },
  ])("rejects a source manifest with the wrong $name", async ({ manifestEntry }) => {
    const root = await createPacketRoot();
    const artifact = "sealed evidence\n";
    const manifest = manifestEntry(artifact);
    await writeFile(join(root, "artifact.txt"), artifact);
    await writeFile(join(root, "SOURCE-SHA256SUMS"), manifest);
    const indexPath = await writeIndex(root, [
      {
        id: "source-manifest",
        kind: "source-manifest",
        artifactStatus: "PASS",
        evidenceStatus: "PASS",
        path: "SOURCE-SHA256SUMS",
        sha256: sha256(manifest),
        description: "The copied source manifest.",
      },
      {
        id: "sealed-run",
        kind: "sealed-run",
        artifactStatus: "PASS",
        evidenceStatus: "PASS",
        path: "artifact.txt",
        sha256: sha256(artifact),
        sourceManifestSha256: sha256(manifest),
        sourceManifestPath: "./artifact.txt",
        description: "A copied checksummed result.",
      },
    ]);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr: "FAIL: ARTIFACT_INVALID: sealed-run: source manifest entry mismatch\n",
    });
  });

  it("rejects a malformed source manifest", async () => {
    const root = await createPacketRoot();
    const artifact = "sealed evidence\n";
    const manifest = "not a checksum manifest\n";
    await writeFile(join(root, "artifact.txt"), artifact);
    await writeFile(join(root, "SOURCE-SHA256SUMS"), manifest);
    const indexPath = await writeIndex(root, [
      {
        id: "source-manifest",
        kind: "source-manifest",
        artifactStatus: "PASS",
        evidenceStatus: "PASS",
        path: "SOURCE-SHA256SUMS",
        sha256: sha256(manifest),
        description: "The copied source manifest.",
      },
      {
        id: "sealed-run",
        kind: "sealed-run",
        artifactStatus: "PASS",
        evidenceStatus: "PASS",
        path: "artifact.txt",
        sha256: sha256(artifact),
        sourceManifestSha256: sha256(manifest),
        sourceManifestPath: "./artifact.txt",
        description: "A copied checksummed result.",
      },
    ]);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr: "FAIL: ARTIFACT_INVALID: source-manifest: malformed source manifest\n",
    });
  });

  it("rejects unknown index fields", async () => {
    const root = await createPacketRoot();
    const indexPath = await writeIndex(root, [
      {
        id: "three-tab-recording",
        kind: "recording",
        artifactStatus: "MISSING",
        evidenceStatus: "MISSING",
        path: null,
        sha256: null,
        description: "No authenticated browser recording exists yet.",
        evidence: "available but unverified",
      },
    ]);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr: expect.stringContaining("FAIL: INDEX_INVALID: cannot decode index"),
    });
  });

  it("rejects invocation without an index", async () => {
    await expect(runVerifier()).rejects.toMatchObject({
      stderr: "FAIL: INDEX_INVALID: expected one artifact index path\n",
    });
  });

  it("rejects invocation with more than one index", async () => {
    await expect(runVerifier("first.json", "second.json")).rejects.toMatchObject({
      stderr: "FAIL: INDEX_INVALID: expected one artifact index path\n",
    });
  });

  it("fails closed when an indexed artifact is missing", async () => {
    const root = await createPacketRoot();
    const indexPath = await writeIndex(root, [
      {
        id: "missing-file",
        kind: "sealed-run",
        artifactStatus: "PASS",
        evidenceStatus: "PASS",
        path: "does-not-exist.json",
        sha256: sha256("expected bytes"),
        description: "The path is indexed but absent.",
      },
    ]);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr: "FAIL: ARTIFACT_INVALID: missing-file: indexed artifact is missing\n",
    });
  });

  it("fails closed when an intermediate directory symlink escapes the packet", async () => {
    const root = await createPacketRoot();
    const outside = await createPacketRoot();
    const artifact = "outside evidence\n";
    await writeFile(join(outside, "artifact.txt"), artifact);
    await symlink(outside, join(root, "linked-outside"), "dir");
    const indexPath = await writeIndex(root, [
      {
        id: "escaped-file",
        kind: "sealed-run",
        artifactStatus: "PASS",
        evidenceStatus: "PASS",
        path: "linked-outside/artifact.txt",
        sha256: sha256(artifact),
        description: "Lexically contained but canonically outside.",
      },
    ]);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr: "FAIL: ARTIFACT_INVALID: escaped-file: path escapes packet directory\n",
    });
  });

  it("fails closed when an artifact checksum differs", async () => {
    const root = await createPacketRoot();
    await writeFile(join(root, "artifact.txt"), "actual bytes");
    const indexPath = await writeIndex(root, [
      {
        id: "changed-file",
        kind: "sealed-run",
        artifactStatus: "PASS",
        evidenceStatus: "PASS",
        path: "artifact.txt",
        sha256: sha256("expected bytes"),
        description: "The indexed digest must match exact bytes.",
      },
    ]);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr: "FAIL: ARTIFACT_INVALID: changed-file: checksum mismatch\n",
    });
  });
});
