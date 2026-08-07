# AgentRun worker

## OpenRouter live qualification

The normal test suite is network-free. Run the credential-dependent live seam
only from a checkout whose ignored `.env` contains `OPENROUTER_API_KEY`:

```sh
bun run --env-file=.env --cwd apps/agent-run-worker qualify:openrouter-live
```

The command executes one fixed, non-sensitive prompt through the immutable
OpenRouter profile and the repository executor. It prints no credential or
response content. A successful run prints one sanitized `PASS` record with the
non-secret binding facts and conformance booleans. The normalized response must
equal lowercase `qualified` after trimming surrounding whitespace; the text
itself is never printed. The profile sends exactly one MiniMax M3 request with
reasoning enabled, fallbacks disabled, and a fixed 1,024-token output ceiling.
That ceiling leaves room for visible text in the qualified prompt while keeping
reasoning and response size bounded.
