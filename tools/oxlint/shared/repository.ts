import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

const WorkspaceManifest = Schema.Struct({ workspaces: Schema.Array(Schema.String) });
const PackageManifest = Schema.Struct({ name: Schema.String });

type PackageRoot = {
  readonly name: string;
  readonly path: string;
};

export const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const decodeWorkspaceManifest = Schema.decodeUnknownSync(Schema.fromJsonString(WorkspaceManifest));
const decodePackageManifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest));

function workspaceRoots(): ReadonlyArray<string> {
  const manifest = decodeWorkspaceManifest(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );

  return manifest.workspaces.flatMap((workspace) => {
    if (!workspace.endsWith("/*")) return [join(repositoryRoot, workspace)];

    const parent = join(repositoryRoot, workspace.slice(0, -2));
    if (!existsSync(parent)) return [];

    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  });
}

const packageRoots = workspaceRoots().flatMap((path): ReadonlyArray<PackageRoot> => {
  const manifestPath = join(path, "package.json");
  if (!existsSync(manifestPath)) return [];

  const manifest = decodePackageManifest(readFileSync(manifestPath, "utf8"));
  return [{ name: manifest.name, path }];
});

export function findPackage(path: string): PackageRoot | undefined {
  const normalizedPath = normalize(path);
  return packageRoots.find(
    (candidate) =>
      normalizedPath === candidate.path || normalizedPath.startsWith(`${candidate.path}${sep}`),
  );
}

export function resolveImport(filename: string, specifier: string): string {
  return resolve(dirname(filename), specifier);
}

export function toRepositoryPath(filename: string): string {
  return relative(repositoryRoot, resolve(filename)).split(sep).join("/");
}
