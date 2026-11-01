---
description: Use when reviewing pull requests, applying review findings, or turning reviewer or AI-council findings into tickets.
---

# Pull Request Review

The checklist is the root CLAUDE.md «PR-чеклист», plus the adversarial-review canon (`.claude/memory/chunks/process/adversarial-review.md`: at least 3 participants with distinct lenses). This skill adds how to treat findings.

- Check coding standards, type safety and validation, security, performance, and test coverage.

## A finding is a hypothesis

- About a third of model review findings are false. Before applying one, verify it against the code on the target branch: quote file:line and follow the call path.
- Check reachability first. Before fixing how element E looks or behaves in context C, prove that E renders in C — the gating condition with its file:line, or a runtime count with seeded data. A fix on unreachable UI adds code no user ever runs.

## From findings to tickets

- Keep "find and classify" (real defect / already fixed / false / not about code / owner's decision) separate from "refute before filing". A ticket is created only for a finding that survived an independent attempt to disprove it. Duplicates of known cards are linked, not filed again.
- Each ticket carries file:line, how to reproduce it, and the direction of the fix, so the owner can act without re-reading the code.

## Tests that can fail

- A table-driven or generated test whose cases come from the implementation's own constants only restates them. Require an independent source for the cases (an explicit table, framework metadata) and a deletion mutation that turns the test red.
- If correctness rests on an incidental ordering elsewhere (a tie-break, iteration order, sort stability), make the code order-independent or pin the ordering with a test that flips it.

## Claims in the Definition of Done

- Green unit tests prove the logic, not the calibration or the boundary. For thresholds, heuristics and control loops (agent ↔ server, worker ↔ queue, webhook ↔ receiver), require one live run with the real counterpart, and read the recorded reasons for its decisions before calling the work done.
- Every reported count comes with the literal command that produced it. When verifying, re-run that command first and flag any count that does not match.
