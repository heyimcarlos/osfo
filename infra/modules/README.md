# Terraform module boundary

Modules are added only when their complete resource behavior enters an
implementation ticket. The approved dependency direction is:

```text
foundation -> platform -> runtime
```

Roots never read another root's state. Provider data sources may discover
provider-owned resources, and a maintainer may pass an explicitly published,
non-secret identifier from a foundation or platform output into a downstream
root's reviewed variable set.

The approved module names are `environment-baseline`, `data-authority`,
`command-buffer`, `public-edge`, `native-transport-runtime`, `relay-runtime`,
`agentrun-runtime`, `temporal-runtime`, and `operating-contract`. Ticket 77
creates the state and validation foundation without speculative empty modules.
External modules, when introduced, must use an exact registry version or an
immutable 40-character Git commit SHA.
