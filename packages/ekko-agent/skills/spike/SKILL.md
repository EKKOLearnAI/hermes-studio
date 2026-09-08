---
name: spike
description: Build small throwaway prototypes to validate feasibility, compare approaches, measure risks, and report an evidence-based verdict.
metadata:
  keywords:
    - technical spike
    - throwaway prototype
    - feasibility prototype
---

# Spike

Use when the user asks to test an idea before committing to a production build: “spike this”, “quick prototype”, “is this possible”, “compare A and B”, or “before we build”.

Do not use when documentation or source inspection can answer the question, or when the user requested production implementation.

## Loop

1. State the concrete feasibility question.
2. Read enough documentation or source to choose a credible approach.
3. Create the smallest runnable artifact that validates or invalidates the idea.
4. Exercise one important edge case or failure mode.
5. Report `VALIDATED`, `PARTIAL`, or `INVALIDATED`.

## Workspace

- Default: `.tmp/spikes/<slug>` for disposable work.
- Tracked option: `spikes/<NNN-slug>/` with a README and minimal code, only when the user wants the prototype kept.
- Prefer a runnable CLI, tiny HTML page, one endpoint, or a focused test.
- Avoid package sprawl, Docker, environment files, app frameworks, and production cleanup.

For multiple questions, split them into two to five independent spikes, run the riskiest first, and keep A/B inputs and measurements equal. Ask before building every variant when the work is no longer small.

## Verdict

```markdown
## Verdict: VALIDATED | PARTIAL | INVALIDATED

Question: ...
Evidence: exact command, output, or measurement.
What worked: ...
What failed or surprised us: ...
Recommendation: ship, adjust, or avoid, with the next production step.
```

An invalidated spike is useful when it rules out a path with evidence. Do not merge disposable spike code into production without rewriting it to production standards. When evaluating dependencies, check maintenance activity, documentation, license, and install friction.
