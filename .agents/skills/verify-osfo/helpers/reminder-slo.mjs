/* oxlint-disable effecttsgo/global-date -- This standalone verifier normalizes provider RFC 3339 timestamps without an Effect runtime. */

const [command, dueText, acceptedText] = process.argv.slice(2);

const parseInstant = (label, text) => {
  if (
    text === undefined ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)
  ) {
    throw new Error(`${label} must be an RFC 3339 instant`);
  }
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is not a valid instant`);
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
};

if (command === "normalize") {
  process.stdout.write(`${parseInstant("nominal due", dueText).iso}\n`);
  process.exit(0);
}

if (command === "assert" || command === "assert-handler") {
  const due = parseInstant("nominal due", dueText);
  const accepted = parseInstant(
    command === "assert" ? "provider acceptance" : "handler commit",
    acceptedText,
  );
  const elapsedMilliseconds = accepted.milliseconds - due.milliseconds;
  const maximumMilliseconds = command === "assert" ? 90_000 : 60_000;
  if (elapsedMilliseconds < 0 || elapsedMilliseconds > maximumMilliseconds) {
    throw new Error(
      `due-to-${command === "assert" ? "provider acceptance" : "handler commit"} was ${elapsedMilliseconds}ms; expected 0..${maximumMilliseconds}ms`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      acceptedAt: accepted.iso,
      elapsedMilliseconds,
      maximumMilliseconds,
      nominalDueAt: due.iso,
    })}\n`,
  );
  process.exit(0);
}

throw new Error(
  "Usage: reminder-slo.mjs normalize <nominal-due> | assert <nominal-due> <accepted-at> | assert-handler <nominal-due> <committed-at>",
);
