# ADR 0006: Standardize Effect scenarios and evidence

Date: 2026-08-12

Status: Accepted

Osfo uses one test-only end-to-end scenario package. A test author writes one
`scenario()` body as an Effect. Required Effect services declare the scenario's
target capabilities, and target Layers run the same body against applicable
local, preview, and live systems.

Every run has isolated identity and storage. It emits a machine-readable result
and the applicable browser, terminal, semantic trace, and timing artifacts. An
applicable target produces PASS, FAIL, or MISSING. A target outside the scenario
contract produces NOT_APPLICABLE with a reason and no verdict. Osfo does not use
a SKIP verdict, and a retry does not convert an initial failure into PASS.

The first implementation establishes the interface, target registry, result
Schema, manifest, summary, one local Worker and Durable Object smoke scenario,
and one negative-control oracle test. It does not build the complete Oz journey
suite. Later runtime tickets add their accepted journeys to the same package.
Protected live provider smoke tests run after merge, and the complete live
target matrix runs before release or promotion.

This gives agents one transparent feedback path without making the first Oz
foundation wait for speculative targets or a complete Executor-sized harness.
