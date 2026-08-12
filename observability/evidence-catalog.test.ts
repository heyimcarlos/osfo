import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { compileEvidenceCatalog, EvidenceCatalogError } from "./evidence-catalog.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

interface FixtureArtifact {
  readonly id: string;
  readonly kind: string;
  readonly artifactStatus: "PASS" | "MISSING";
  readonly evidenceStatus: "PASS" | "FAIL" | "MISSING";
  readonly path: string | null;
  readonly sha256: string | null;
  readonly description: string;
  readonly sourceManifestSha256?: string;
  readonly sourceManifestPath?: string;
}

const source = (
  id: string,
  adapter: "packet-index" | "evidence-markdown" | "packet-runs" | "github-context",
  path: string,
) => ({
  id,
  adapter,
  category: id,
  path,
  publicUrl: `https://example.test/${path}`,
  structure: "fixture",
  seal: adapter === "github-context" ? "unsealed-external-context" : "fixture-checksum",
  scope: adapter === "github-context" ? "contextual" : "mixed",
  disposition: adapter === "github-context" ? "link" : "import",
  exclusionReason:
    adapter === "github-context" ? "External context cannot establish qualification." : null,
  issueOrRequirement: [id],
  required: true,
});

const writeFixture = async (
  options: { readonly tamper?: boolean; readonly duplicate?: boolean } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "osfo-evidence-catalog-"));
  const packet = join(root, "docs/openpoke-v1-demo");
  const artifacts: FixtureArtifact[] = [];

  const rows = [
    ...Array.from(
      { length: 37 },
      (_, index) =>
        `| Requirement ${index + 1} | measured | ${index === 1 ? "FAIL" : index === 2 ? "MISSING" : "PASS"} | [source](evidence/runs/run-01/scenario.json) |`,
    ),
    ...Array.from({ length: 10 }, (_, index) => `| Input ${index + 1} | ${index + 1} |`),
  ];
  const markdown = [
    "# Evidence",
    "",
    "## Requirements",
    "",
    "| Requirement | Result | Status | Source |",
    "| --- | --- | --- | --- |",
    ...rows.slice(0, 37),
    "",
    "## Inputs",
    "",
    "| Input | Current value |",
    "| --- | ---: |",
    ...rows.slice(37),
    "",
  ].join("\n");
  await mkdir(packet, { recursive: true });
  await writeFile(join(packet, "evidence.md"), markdown);
  artifacts.push({
    id: "evidence-matrix",
    kind: "document",
    artifactStatus: "PASS",
    evidenceStatus: "MISSING",
    path: "evidence.md",
    sha256: digest(markdown),
    description: "Evidence matrix.",
  });

  for (let index = 1; index <= 13; index += 1) {
    const run = `run-${String(index).padStart(2, "0")}`;
    const directory = join(packet, "evidence/runs", run);
    const scenario = JSON.stringify({
      benchmark_id: `fixture-${index}`,
      lane: index <= 4 ? `matrix-${["A", "B", "C", "D"][index - 1]}-fixture` : "target-232",
      region: index <= 4 ? "us-east4" : undefined,
      worker_delivery: "pull",
      started_at: `2026-08-07T00:${String(index).padStart(2, "0")}:00Z`,
      ended_at: `2026-08-07T00:${String(index).padStart(2, "0")}:30Z`,
    });
    const sourceManifest = `${digest(scenario)}  ./scenario.json\n`;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "scenario.json"), scenario);
    await writeFile(join(directory, "SOURCE-SHA256SUMS"), sourceManifest);
    const manifestId = `${run}-source-manifest`;
    artifacts.push({
      id: manifestId,
      kind: "source-manifest",
      artifactStatus: "PASS",
      evidenceStatus: "PASS",
      path: `evidence/runs/${run}/SOURCE-SHA256SUMS`,
      sha256: digest(sourceManifest),
      description: "Copied source manifest.",
    });
    artifacts.push({
      id: `${run}-scenario`,
      kind: "sealed-run",
      artifactStatus: "PASS",
      evidenceStatus: index === 2 ? "FAIL" : "PASS",
      path: `evidence/runs/${run}/scenario.json`,
      sha256: options.tamper && index === 1 ? "0".repeat(64) : digest(scenario),
      sourceManifestSha256: digest(sourceManifest),
      sourceManifestPath: "./scenario.json",
      description: "Copied scenario.",
    });
  }
  if (options.duplicate) artifacts.push(artifacts[0]!);

  const index = JSON.stringify({ schemaVersion: 1, packet: "openpoke-v1-demo", artifacts });
  await writeFile(join(packet, "artifact-index.json"), index);
  const manifest = {
    schemaVersion: 1,
    repositoryUrl: "https://example.test/",
    sources: [
      source("packet-index", "packet-index", "docs/openpoke-v1-demo/artifact-index.json"),
      source("evidence-narrative", "evidence-markdown", "docs/openpoke-v1-demo/evidence.md"),
      source("packet-runs", "packet-runs", "docs/openpoke-v1-demo/evidence/runs"),
    ],
  };
  const manifestPath = join(root, "observability/evidence-catalog.manifest.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, manifestPath };
};

describe("manifest-driven evidence catalog", () => {
  it("compiles the repository catalog with complete packet and matrix coverage", async () => {
    const result = await compileEvidenceCatalog(
      join(process.cwd(), "observability/evidence-catalog.manifest.json"),
      { repoRoot: process.cwd() },
    );

    expect(result.coverage.find((item) => item.sourceId === "evidence-narrative")?.count).toBe(47);
    expect(result.coverage.find((item) => item.sourceId === "packet-runs")?.count).toBe(13);
    expect(result.catalog.filter((item) => item.sourceId === "packet-runs")).toHaveLength(13);
    for (const cell of ["A", "B", "C", "D"]) {
      const record = result.catalog.find((item) => item.id === `matrix-${cell}-admission`);
      expect(record?.status).toBe("FAIL");
      expect(record?.qualificationScope).toBe("production");
      expect(record?.facts.find((item) => item.name === "offered")?.value).toBe(417_600);
    }
    for (const cut of ["before", "after"]) {
      const record = result.catalog.find((item) => item.id === `run-worker-loss-${cut}-claim`);
      expect(record?.facts.find((item) => item.name === "duplicate_terminal_commits")?.value).toBe(
        0,
      );
      expect(record?.facts.find((item) => item.name === "terminal_uniqueness")?.value).toBe(true);
      expect(
        record?.facts.find((item) => item.name === "unfinished_agent_run_attempts")?.value,
      ).toBe(0);
      expect(
        record?.facts.find((item) => item.name === "capacity_reservations_released")?.value,
      ).toBe(true);
    }
    expect(result.catalog.find((item) => item.id === "issue-67")).toMatchObject({
      qualificationScope: "contextual",
      status: "PASS",
    });
    expect(result.catalog.find((item) => item.id === "issue-68")).toMatchObject({
      qualificationScope: "contextual",
      status: "PASS",
    });
    const actionRequirements = result.catalog.find((item) => item.id === "issue-68")?.requirements;
    expect(actionRequirements?.find((item) => item.status === "PASS")?.requirement).toContain(
      "current-local-foundation-only",
    );
    expect(actionRequirements?.filter((item) => item.status === "MISSING")).toHaveLength(8);
    expect(result.catalog.find((item) => item.gate === "cancellation_request")?.status).toBe(
      "PASS",
    );
    expect(result.catalog.find((item) => item.gate === "cancellation_completion")?.status).toBe(
      "MISSING",
    );
    expect(result.catalog.find((item) => item.gate === "current_image_digest")?.status).toBe(
      "MISSING",
    );
    expect(
      result.catalog
        .find((item) => item.id === "development-runtime-current")
        ?.facts.find((item) => item.name === "executionprofile")?.value,
    ).toBe("oz.openrouter.minimax.minimax-m3.chat-completions.v1");
    expect(
      result.catalog
        .find((item) => item.id === "development-runtime-current")
        ?.facts.find((item) => item.name === "modelbinding")?.value,
    ).toBe("openrouter.chat-completions.minimax.minimax-m3.v1");
    expect(
      result.catalog.find(
        (item) => item.environment === "production" && item.gate === "action_receipt",
      )?.status,
    ).toBe("MISSING");
    expect(
      result.catalog
        .filter(
          (item) =>
            item.sourceId === "evidence-narrative" &&
            item.limitations[0]?.includes("configuration"),
        )
        .every((item) => item.status === "MISSING"),
    ).toBe(true);
    expect(
      result.catalog
        .filter((item) => item.environment !== "production")
        .every((item) => item.qualificationScope !== "production"),
    ).toBe(true);
    expect(result.metrics).not.toMatch(/production_qualification[^\n]*\s0(?:\.0+)?$/mu);
    expect(JSON.stringify(result)).not.toContain("/home/");

    const committedRoot = join(process.cwd(), "docs/openpoke-v1-demo/evidence/catalog");
    expect(
      JSON.parse(await readFile(join(committedRoot, "normalized-catalog.json"), "utf8")),
    ).toEqual(result.catalog);
    expect(JSON.parse(await readFile(join(committedRoot, "coverage-report.json"), "utf8"))).toEqual(
      result.coverage,
    );
    expect(JSON.parse(await readFile(join(committedRoot, "import-report.json"), "utf8"))).toEqual(
      result.importReport,
    );
  });

  it("covers every Markdown row and discovers every packet run without promoting context", async () => {
    const fixture = await writeFixture();

    const result = await compileEvidenceCatalog(fixture.manifestPath, { repoRoot: fixture.root });

    expect(result.coverage.find((item) => item.sourceId === "evidence-narrative")?.count).toBe(47);
    expect(result.coverage.find((item) => item.sourceId === "packet-runs")?.count).toBe(13);
    expect(result.catalog.filter((item) => item.sourceId === "packet-runs")).toHaveLength(13);
    expect(
      result.catalog
        .filter((item) => item.environment !== "production")
        .every((item) => item.qualificationScope !== "production"),
    ).toBe(true);
    expect(result.catalog.find((item) => item.id === "run-run-02")?.status).toBe("FAIL");
    expect(result.metrics).not.toContain('fact="workload.offered"');
    expect(JSON.stringify(result)).not.toContain(fixture.root);
    expect(result.openMetrics).toMatch(/# EOF\n$/u);
  });

  it("rejects duplicate artifact identifiers before producing a catalog", async () => {
    const fixture = await writeFixture({ duplicate: true });

    await expect(
      compileEvidenceCatalog(fixture.manifestPath, { repoRoot: fixture.root }),
    ).rejects.toMatchObject({ code: "DUPLICATE_ID" });
  });

  it("fails closed when an indexed artifact checksum differs", async () => {
    const fixture = await writeFixture({ tamper: true });

    await expect(
      compileEvidenceCatalog(fixture.manifestPath, { repoRoot: fixture.root }),
    ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
  });

  it("forces GitHub snapshots to remain unsealed contextual records", async () => {
    const fixture = await writeFixture();
    const githubPath = join(fixture.root, "docs/openpoke-v1-demo/evidence/catalog/github.json");
    const githubContents = JSON.stringify({
      schemaVersion: 1,
      issues: [
        {
          number: 100,
          title: "Development SSE qualification",
          updatedAt: "2026-08-07T18:00:00Z",
          url: "https://github.com/example/repository/issues/100",
          status: "PASS",
          disposition: "Development lane passed; production remains MISSING.",
        },
      ],
    });
    await mkdir(dirname(githubPath), { recursive: true });
    await writeFile(githubPath, githubContents);
    const artifactIndexPath = join(fixture.root, "docs/openpoke-v1-demo/artifact-index.json");
    const artifactIndex = JSON.parse(await readFile(artifactIndexPath, "utf8")) as {
      artifacts: FixtureArtifact[];
    };
    artifactIndex.artifacts.push({
      id: "github-context",
      kind: "document",
      artifactStatus: "PASS",
      evidenceStatus: "MISSING",
      path: "evidence/catalog/github.json",
      sha256: digest(githubContents),
      description: "Contextual GitHub snapshot.",
    });
    await writeFile(
      artifactIndexPath,
      JSON.stringify({ schemaVersion: 1, packet: "openpoke-v1-demo", ...artifactIndex }),
    );
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as {
      sources: unknown[];
    };
    manifest.sources.push(
      source(
        "github-context",
        "github-context",
        "docs/openpoke-v1-demo/evidence/catalog/github.json",
      ),
    );
    await writeFile(
      fixture.manifestPath,
      JSON.stringify({ schemaVersion: 1, repositoryUrl: "https://example.test/", ...manifest }),
    );

    const result = await compileEvidenceCatalog(fixture.manifestPath, { repoRoot: fixture.root });
    const issue = result.catalog.find((item) => item.id === "issue-100");
    expect(issue).toMatchObject({
      authority: "external-unsealed-github-snapshot",
      classification: "contextual",
      environment: "external-context",
      qualificationScope: "contextual",
      status: "PASS",
    });
  });

  it("rejects absolute and private source paths", async () => {
    const fixture = await writeFixture();
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as {
      sources: Array<{ path: string }>;
    };
    manifest.sources[0]!.path = "/home/person/.env";
    await writeFile(
      fixture.manifestPath,
      JSON.stringify({ schemaVersion: 1, repositoryUrl: "https://example.test/", ...manifest }),
    );

    await expect(
      compileEvidenceCatalog(fixture.manifestPath, { repoRoot: fixture.root }),
    ).rejects.toBeInstanceOf(EvidenceCatalogError);
  });
});
