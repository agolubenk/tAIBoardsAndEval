---
description: Compact task ingress and handoff contract
---

For a new long, vague, Russian-language, or multi-session task, preserve the original prompt and use:

`HEADROOM compress (only if large context) → GLM GOAL/CONSTRAINTS/ACCEPTANCE → targeted DAMS/Serena → HEADROOM handoff`.

`UserPromptSubmit` can run GLM and DAMS but cannot call MCP tools; therefore call
`headroom_compress`/`headroom_retrieve` explicitly only at task ingress and handoff. Never block
work when HEADROOM or GLM is unavailable. Do not send code, secrets, or whole logs to GLM.

## Backlog/bug work — t-boards is canonical (content + status); Notion is a read-only archive

`docs/plans/BACKLOG.md`/`docs/plans/archive/FIX.md` are frozen historical snapshots (2026-08-12) — do not read
them for current open-item scope or detail. For backlog/bug work, start from the t-boards card itself
(full description, priority/severity, discussion live there; MCP `mcp__hub__t-boards_1mcp_*`) and check its status
and `halfBaked` before starting — do not start on a half-baked card without explicit owner go-ahead this turn.
Never write to Notion: it is frozen since the R-084 switch. Details/hard-stops: `.claude/rules/17-notion-board.md`. For "was this already done"
lookups, use `docs/plans/done/` (index `docs/plans/DONE.md`; `rag_query.py --type done_entry`) + `git log`/`git show` — the canonical closed-item history — not
BACKLOG.md/FIX.md. Skip the board check for work that has no backlog/bug origin (new user request,
exploratory question).

## Mandatory task roast before implementation

For a large, ambiguous, cross-domain, or user-visible change, first give a concise evidence-based
review: product flow and affected apps/contracts; data/API/RPC/auth/PII/integrations; design-system
UI (desktop/mobile, i18n, accessibility, loading/empty/error); failure/performance/security/
observability/backward compatibility; acceptance tests, rollout and docs. Mark non-applicable
categories explicitly. If a material product decision remains, ask the user before editing.
Every new task (anything but a continuation, an approval or an answer to the agent's question) starts with skill
`grill-task` in auto mode — the `UserPromptSubmit` hook injects `<grill-task-auto>`. The roast categories above are
the checklist it uses to find product forks: none → work; 1–3 → up to 3 questions before edits; ≥ 4 dependent,
schema migration, auth/PII → offer the full grill, which ends with an owner-approved spec version, never with code.

The roast precedes the work; every decision or proposal that comes out of it then gets an adversarial review by
**at least 3 independent participants** (lenses: correctness/failures · resource cost from server to the user's
browser on a slow network · product fit/simplicity) — canon `.claude/memory/chunks/process/adversarial-review.md`.
