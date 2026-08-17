# Osfo Model Quality Gate

This private package owns the deterministic release policy for the complete Osfo behavior
configuration. It does not call a model provider and it does not create production evidence.

```text
corpus + fixtures + configuration
              |
              v
       execution plan
              |
              v
deterministic graders -> calibrated model or human review
              |
              v
 absolute floors + paired non-inferiority
              |
              v
       PASS | FAIL | MISSING
              |
              v
        canary controls
```

The public seams are package subpath exports. The modules are pure. Callers supply time,
configuration, grader results, traces, and production observations. A missing provider run,
human label, trace, sample, or powered comparison stays `MISSING`.

The initial corpus manifest contains 600 authored or synthetic cases. Pull request plans can use
only development cases. Complete release plans include the sealed holdout. Corpus successors are
immutable, digest-addressed, linked to their previous version, and cannot remove a known failing
case. Sealed fixtures resolve through an access-controlled release vault that is not a package
export. If that vault is unavailable, complete release evidence is `MISSING`. Holdout content and
output must not be given to prompt or route tuning.

Production signals create review leads only. Random human reading of private conversations is
prohibited. Source deletion creates an immediate deletion request for each declared evaluation
copy. Retention calculations use epoch milliseconds to keep time inputs explicit and deterministic.
