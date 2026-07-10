---
description: Implement a task and iterate on sub-agent review until clean.
agent: build
---

Review this task and implement it end-to-end:

`$ARGUMENTS`

Before changing behavior, inspect the relevant code, tests, documentation, templates, and public exports as needed. Prefer the smallest correct implementation and add or update regression coverage for behavior changes.

When the implementation and initial verification are complete, launch a sub-agent to review the diff. Ask it to look specifically for correctness issues, missing tests, security risks, performance problems, concurrency or persistence regressions, public API/documentation drift, and cleanup opportunities.

Fix every relevant in-scope review finding. Then repeat the sub-agent review loop until a review returns no actionable in-scope findings, or until a remaining item is blocked by a product decision or external constraint. Report any unresolved blocker clearly.

Before finishing, review the final diff yourself, run proportionate verification, and summarize what changed and what checks were run.
