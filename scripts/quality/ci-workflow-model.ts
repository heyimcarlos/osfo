export type GateStatus = "PASS" | "FAIL";

export const workflowJobBlock = (workflow: string, job: string) => {
  const start = workflow.indexOf(`  ${job}:\n`);
  if (start < 0) return "";
  const remaining = workflow.slice(start + `  ${job}:\n`.length);
  const next = remaining.search(/^  [a-z][a-z-]+:\n/mu);
  return next < 0 ? remaining : remaining.slice(0, next);
};

export const workflowCommands = (
  workflow: string,
  jobs: readonly string[],
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    jobs.map((job) => {
      const command = /^\s+- run:\s+(.+)$/mu.exec(workflowJobBlock(workflow, job))?.[1];
      return [job, command ?? ""];
    }),
  );

export const executeWorkflowModel = (
  commands: Readonly<Record<string, string>>,
  execute: (job: string, command: string) => number,
): Readonly<Record<string, GateStatus>> =>
  Object.fromEntries(
    Object.entries(commands).map(([job, command]) => [
      job,
      execute(job, command) === 0 ? "PASS" : "FAIL",
    ]),
  );
