import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "@effect/vitest";

const execFileAsync = promisify(execFile);
const verifierPath = join(process.cwd(), "observability/demo-packet-verifier.ts");

const sha256 = (contents: string) => createHash("sha256").update(contents).digest("hex");
const createPacketRoot = () => mkdtemp(join(tmpdir(), "osfo-demo-packet-"));
const writeIndex = async (root: string, artifacts: ReadonlyArray<unknown>) => {
  const indexPath = join(root, "index.json");
  await writeFile(
    indexPath,
    JSON.stringify({ schemaVersion: 1, packet: "openpoke-v1-demo", artifacts }),
  );
  return indexPath;
};
const runVerifier = (...arguments_: ReadonlyArray<string>) =>
  execFileAsync("bun", [verifierPath, ...arguments_]);

describe("OpenPoke demo packet verifier CLI", () => {
  it("accepts verified artifacts and explicit MISSING placeholders", async () => {
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

    expect(result.stdout).toBe("PASS: verified 1 artifact; 1 MISSING\n");
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
        description: "A copied checksummed result.",
      },
    ]);

    await expect(runVerifier(indexPath)).rejects.toMatchObject({
      stderr: "FAIL: INDEX_INVALID: sealed-run: source manifest checksum is not indexed\n",
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
