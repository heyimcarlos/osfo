# Environment learnings

Record only current, reproducible environment facts that are not clear from
repository configuration.

- The desktop runtime's bundled `pdftoppm` can render standard Helvetica with
  overlapping glyphs. The system `/usr/bin/pdftoppm` rendered the same synthetic
  PDF correctly with system font discovery. Chat/PDF verification prefers that
  system binary when present, records its path and version, and requires visual
  inspection before using the raster as OCR evidence.

- On a 32 GiB development machine, `apps/worker`'s PGlite Vitest configuration
  can exhaust memory at its default concurrency. Run it locally with
  `vitest run --config vitest.db.config.ts --maxWorkers=1`.
- Cloudflare Vitest/Miniflare needs each exercised facet class listed as a
  test-only Durable Object binding. Keep those compatibility bindings out of
  `new_sqlite_classes`; without them, facet startup rejects the SDK's
  `StartupOptions.class` before product routing. Even with bindings for
  `ThinkMessengerStateAgent`, `CompanyAgent`, and `OsfoAgent`, Miniflare cannot
  serialize Chat SDK's live `_ThreadImpl` delivery surface across a facet.
  Qualify genuine messenger ingress in real Wrangler/Chrome and use the trusted
  Agent submission seam only to arrange downstream Worker journey state.

- Executor 1.6.8 and its MCP plugin use Effect 4.0.0-beta.59. A separate Node host
  can retain those peers while Worker/API code stays on the workspace version;
  only plain transport data and synchronous codecs cross the runtime boundary.
- Codex app-server direct MCP calls can use a real returned thread identity with
  caller-generated turn correlation metadata. Browser calls still require the
  provisioned desktop broker and enabled browser extension. CLI login alone does
  not provision that connection.
- Installed `@cloudflare/vitest-plugin@1.0.0` explicitly sets
  `enableContainers: false` while deriving Worker options. Its pool cannot
  qualify the actual Sandbox container even when the test Wrangler config
  declares it. Use the existing real-Wrangler verification helper for the
  Files/R2/Sandbox path; native transport tests remain supporting evidence.
