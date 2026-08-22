# Environment learnings

Record only current, reproducible environment facts that are not clear from
repository configuration.

- On a 32 GiB development machine, `apps/worker`'s PGlite Vitest configuration
  can exhaust memory at its default concurrency. Run it locally with
  `vitest run --config vitest.db.config.ts --maxWorkers=1`.
