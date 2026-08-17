# Keep Model Quality as a release-tooling package

## Status

Accepted

## Context

Issue #185 requires deterministic package-quality tooling, immutable manifests,
and a sealed evaluation gate. The gate is not Worker request behavior. It is a
release-control interface for CI and the product release controller.

## Decision

Keep `@osfo/model-quality` as a private workspace package. Its only supported
entry point is `@osfo/model-quality`. The `ModelQualityTooling` facade contains
the release-gate operation and the narrow parsers and constructors needed to
build its verified input. Source modules are implementation details and are
not package export paths.

## Consequences

The package keeps deterministic release tooling outside runtime migrations. A
second product consumer can use the one supported entry point. Until then,
tests import implementation modules by relative path only inside this package.
