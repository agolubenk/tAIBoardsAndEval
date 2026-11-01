---
description: Use when debugging production incidents, analyzing logs across services, and investigating errors or degradations.
---

# Incident Debugging

Production is one VPS behind nginx. The agent has no shell on it and no production database: anything that must run there goes to the owner as exact, read-only commands with the expected output and what to send back.

## 1. Timeline before blame

- The component where an error surfaces is rarely where it starts. Build a merged cross-service timeline first: per-hour counts of each error class on every side (backend, telegram-sessions, nginx, ops agent), then a millisecond-level timeline around one incident. Confirm each log source covers the whole window before reading silence as absence.
- After a config or flag change in a producer → worker setup, name the process that actually reads the flag at execution time (worker, daemon, sidecar) and check that it restarted with the new value. A changed setting in the process that only enqueues the job proves nothing.
- "It broke after the deploy" and "the deploy broke it" are different claims. Before choosing between revert and forward fix, run the before and after versions of the suspect unit on identical inputs (the old file in a scratch copy plus a tiny runner) and compare the outputs.

## 2. Disprove before you file

- For every candidate cause, name the cheapest observation that would refute it, and run that observation before writing the cause into a card, PR or document. One correlated log line is not a cause.
- Before asking anyone to run an experiment on a live system, mine the logs you already have for every variable the hypotheses depend on (versions and digests, sizes against limits, timings) and rank the hypotheses with them. A probe must reproduce the state its hypothesis relies on: scale, references that keep objects alive, the order of cleanup steps. Prefer a read-only listing of the live state over a synthetic reproduction. Example: every deploy log already printed the build cache before and after the prune (24.75 GB both times, cap 20 GB), yet two synthetic probes ran before anyone read those numbers — and the probe image carried its own tag, a reference the deploy's intermediate layers lack.

## 3. Commands for remote shells

- A process guard in a `bash -c` or ssh one-liner: `pgrep -f pattern` also matches the guard's own command line. Use `pgrep -fa "[p]attern"` and run the "nothing running" branch once — it must exit 1 — before relying on the guard.
- Commands for the owner's server are read-only by default (for psql: `PGOPTIONS="-c default_transaction_read_only=on"`) and print counts or booleans instead of secret-bearing lines.

## 4. Record

- Write the confirmed cause, the refuted ones, and the evidence (file:line, log excerpt, command) into the t-boards card (`create_task_comment`). A bug found on the way gets its own t-boards card in «Ошибки». Notion is a read-only archive.
