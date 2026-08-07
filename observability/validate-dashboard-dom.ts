import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ExpectedDashboardContext {
  readonly range: string;
  readonly run: string;
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

export const validateDashboardDom = (
  html: string,
  expected: ExpectedDashboardContext,
): { readonly panelCount: number; readonly visibleText: string } => {
  const visibleText = visibleTextFrom(html);
  const failures: string[] = [];
  if (!visibleText.includes(expected.run)) failures.push("selected run is absent");
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

  const panelCount = (html.match(/data-testid="data-testid Panel header /gu) ?? []).length;
  if (panelCount === 0) failures.push("no dashboard panels rendered");
  if (failures.length > 0) throw new Error(failures.join("; "));
  return { panelCount, visibleText };
};

const runCli = async (): Promise<void> => {
  const [domPath, run, range] = process.argv.slice(2);
  if (domPath === undefined || run === undefined || range === undefined) {
    throw new Error("usage: validate-dashboard-dom.ts DOM.html RUN UTC_RANGE");
  }
  validateDashboardDom(await readFile(resolve(domPath), "utf8"), { range, run });
};

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runCli().catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
