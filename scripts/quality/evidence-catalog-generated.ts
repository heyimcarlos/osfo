import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileEvidenceCatalog } from "../../observability/evidence-catalog.js";

export interface GeneratedCatalogOptions {
  readonly repoRoot: string;
  readonly manifestPath: string;
  readonly catalogRoot: string;
  readonly mode: "--check" | "--write";
}

export const runGeneratedCatalog = async (options: GeneratedCatalogOptions) => {
  const result = await compileEvidenceCatalog(options.manifestPath, {
    repoRoot: options.repoRoot,
  });
  const outputs = [
    ["normalized-catalog.json", `${JSON.stringify(result.catalog, undefined, 2)}\n`],
    ["coverage-report.json", `${JSON.stringify(result.coverage, undefined, 2)}\n`],
    ["import-report.json", `${JSON.stringify(result.importReport, undefined, 2)}\n`],
  ] as const;

  if (options.mode === "--write") {
    for (const [name, contents] of outputs) {
      await writeFile(join(options.catalogRoot, name), contents);
    }
    return { status: 0, message: `PASS: regenerated ${outputs.length} catalog outputs` } as const;
  }

  const drifted: string[] = [];
  for (const [name, contents] of outputs) {
    const committed = await readFile(join(options.catalogRoot, name), "utf8").catch(
      () => undefined,
    );
    if (committed !== contents) drifted.push(name);
  }
  return drifted.length > 0
    ? {
        status: 1,
        message: `FAIL: generated catalog output drifted: ${drifted.join(", ")}. Run bun run generated:write.`,
      }
    : { status: 0, message: `PASS: ${outputs.length} generated catalog outputs are current` };
};

const main = async () => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const mode = process.argv[2];
  if (mode !== "--check" && mode !== "--write") {
    process.stderr.write("usage: evidence-catalog-generated.ts --check|--write\n");
    process.exitCode = 1;
    return;
  }
  const result = await runGeneratedCatalog({
    repoRoot,
    manifestPath: join(repoRoot, "observability/evidence-catalog.manifest.json"),
    catalogRoot: join(repoRoot, "docs/openpoke-v1-demo/evidence/catalog"),
    mode,
  });
  const stream = result.status === 0 ? process.stdout : process.stderr;
  stream.write(`${result.message}\n`);
  process.exitCode = result.status;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
