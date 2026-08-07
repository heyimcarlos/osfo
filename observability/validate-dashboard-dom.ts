import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ExpectedDashboardContext {
  readonly alias: string;
  readonly range: string;
}

const visibleTextFrom = (html: string): string =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/\s+/gu, " ")
    .trim();

const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;

export const validateDashboardDom = (
  html: string,
  expected: ExpectedDashboardContext,
): { readonly panelCount: number; readonly visibleText: string } => {
  const visibleText = visibleTextFrom(html);
  const failures: string[] = [];
  if (!visibleText.includes(expected.alias)) failures.push("human evidence alias is absent");
  if (!visibleText.includes(expected.range)) failures.push("locked UTC range is absent");
  if (/\bNo data\b/iu.test(visibleText)) failures.push("a panel reports No data");
  if (/\b(?:Loading|Loading\.\.\.)\b/iu.test(visibleText)) {
    failures.push("a panel is still loading");
  }
  if (
    /Grafana has failed to load|An unexpected error happened|Panel plugin not found/iu.test(
      visibleText,
    )
  ) {
    failures.push("Grafana reports a render error");
  }
  if (/\b__name__\b|\bopenpoke_catalog_[a-z_]+\b|\bsource_hash\b/iu.test(visibleText)) {
    failures.push("a human table exposes raw metric labels");
  }

  const provenanceOffset = visibleText.indexOf("Raw provenance, below fold");
  const firstViewportText =
    provenanceOffset === -1 ? visibleText : visibleText.slice(0, provenanceOffset);
  if (uuidPattern.test(firstViewportText)) failures.push("a full UUID appears above provenance");

  const panelCount = (html.match(/data-testid="data-testid Panel header /gu) ?? []).length;
  if (panelCount === 0) failures.push("no dashboard panels rendered");
  if (failures.length > 0) throw new Error(failures.join("; "));
  return { panelCount, visibleText };
};

const uint32 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) * 0x1000000 +
    (bytes[offset + 1] ?? 0) * 0x10000 +
    (bytes[offset + 2] ?? 0) * 0x100 +
    (bytes[offset + 3] ?? 0)) >>>
  0;

export const validateDashboardCapture = (
  html: string,
  screenshot: Uint8Array,
  expected: ExpectedDashboardContext,
): { readonly panelCount: number; readonly visibleText: string } => {
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (screenshot.length < 24 || pngSignature.some((byte, index) => screenshot[index] !== byte)) {
    throw new Error("screenshot is not a PNG");
  }
  const width = uint32(screenshot, 16);
  const height = uint32(screenshot, 20);
  if (width !== 1920 || height !== 1080) {
    throw new Error(`screenshot is ${width}x${height}, expected 1920x1080`);
  }
  return validateDashboardDom(html, expected);
};

const runCli = async (): Promise<void> => {
  const [domPath, screenshotPath, alias, range] = process.argv.slice(2);
  if (
    domPath === undefined ||
    screenshotPath === undefined ||
    alias === undefined ||
    range === undefined
  ) {
    throw new Error("usage: validate-dashboard-dom.ts DOM.html SCREENSHOT.png ALIAS UTC_RANGE");
  }
  validateDashboardCapture(
    await readFile(resolve(domPath), "utf8"),
    await readFile(resolve(screenshotPath)),
    { alias, range },
  );
};

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runCli().catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
