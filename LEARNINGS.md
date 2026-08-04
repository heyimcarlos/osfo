# Environment learnings

- 2026-08-02: The active Docker 29.6.2 daemon is rootful. Constrained local
  Docker results validate the SandboxProvider seam, not hostile-code isolation.
- 2026-08-02: Google Cloud Application Default Credentials are available, so
  Cloud SQL Auth Proxy can use IAM database authentication without repository
  credentials.
- 2026-08-02: Temporal Rust SDK 0.5.0 macros require direct `futures` and
  `temporalio-workflow` dependencies. Rig 0.41.0 raises the shared minimums to
  futures 0.3.32, serde_json 1.0.150, and Tokio 1.52.3.
- 2026-08-02: Temporal Rust SDK 0.5.0 can replay a real 38-event workflow
  history and detect an intentional durable-command mismatch. Constructing the
  replay worker requires `temporalio-sdk-core` and
  `Worker::new_from_core`, which is marked `#[doc(hidden)]`; the core crate says
  its APIs are unstable.
- 2026-08-03: Temporal Cloud OpenMetrics accepts a separate service-account API
  key with the Metrics Read-Only role. Prometheus runs as UID 65534 in the
  pinned container, so the remote bind-mounted key can remain narrowly readable
  by making that UID the owner with mode 0400. The local source key remains mode
  0600.
