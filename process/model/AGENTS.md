# Developer AI task contract

Use this project contract in Codex. The user's original wording remains authoritative.

For a new, long, ambiguous, Russian-language, or cross-session task, follow this minimal chain:

1. If a HEADROOM MCP tool is available, compress only the raw task or attached large context.
2. Run `.claude/scripts/glm_client.py` to form the compact English `GOAL / CONSTRAINTS / ACCEPTANCE` brief. If GLM is unavailable, retain the original task and continue without a brief.
3. Use Serena/symbol search and DAMS/RAG only for the files relevant to that brief; do not bulk-load project documents.
4. Before a handoff or context limit, save `{done, remaining, key files, verification}` with HEADROOM. The next agent retrieves it only when `.claude/memory/session/latest.md` is insufficient.

## Roles

Each directory with its own expertise has a `CLAUDE.md` role card: role, ownership, decision logic, verified
commands and quality gate (e.g. `apps/backend/CLAUDE.md` → nested `prisma/`, `src/modules/ai/`,
`src/modules/integrations/`; `apps/frontend/src/locales/CLAUDE.md` for translations; `docs/qa/CLAUDE.md` for testing).
Harnesses that do not auto-load nested `CLAUDE.md`: read the nearest card (and its parents) before working in a
directory. The role map, Never/Always rules and Definition of Done are in the root `CLAUDE.md`; enforceable laws —
`.claude/rules/`; role knowledge and artifacts — `docs/<role folder>/` (map: `docs/README.md`).

## Owner queue

Anything the owner must do — a decision, a merge, a server command, a manual check — goes to the **owner queue**
through the `oq_*` MCP tools (`owner-queue` server: `oq_list`, `oq_get`, `oq_put`, `oq_patch`, `oq_agent_status`,
`oq_history`), not only into the chat. The owner answers at https://ops.admin.hrhelper.space/queue or in the Telegram
bot @hrhelper_owner_queue_bot. Read the owner's answers with `oq_list checks` and never change them; your own status
goes through `oq_agent_status`. Write only items whose `source` is your session. Spec: `docs/specs/owner-queue.md`.
The claude.ai queue artifact has been frozen since 2026-10-18: do not write to it.

## Adversarial review — at least 3 participants (mandatory for every specialist)

Every decision or proposal (approach, contract, schema, UX, plan) is attacked by **x ≥ 3 independent participants**,
each with its own lens; the author never reviews themself. Base lenses: correctness and failure modes · **resource cost
at every level** — server, network and the user's device ("Africa test": 3G, low-end Android, metered data; measure,
don't guess) · product fit and simplicity. x grows with risk (4–5 for auth/PII/migrations/prod/multi-app, 6+ for
ADR-level), never below 3; add a participant only for a new lens. Pick the best engineering option that follows the
product intent and saves resources; report "x participants (lenses) → objections → decision, rejected alternatives,
numbers". Canon: `.claude/memory/chunks/process/adversarial-review.md`; role-specific lenses — in each `CLAUDE.md`.
Local Ollama models run strictly sequentially — never parallelise local reviewers.

## Mandatory task roast

Before implementation of a large, ambiguous, cross-domain, or user-visible change, perform a
short decision review. State the findings and unresolved choices before editing; ask the user
rather than silently making a materially product-changing choice. Cover every applicable area:

1. Product/domain flow, affected applications and existing architecture/contracts.
2. Data model, migrations, API/RPC, authorization, privacy/PII, integrations and realtime/jobs.
3. UI: existing design-system patterns, desktop/mobile states, i18n, accessibility, loading/empty/error states.
4. Failure modes, performance/scale, observability, security and backward compatibility.
5. Concrete acceptance checks, tests, rollout/migration and documentation impact.

Use targeted code/RAG/Serena evidence, not speculative bulk reading. For a clearly local change,
record why a category is not applicable instead of inventing analysis.

## Skills (any agent, any model)

Vendored design and Swift skills are available to every harness: `.agents/skills/` (Codex, Cursor,
Gemini CLI, GitHub Copilot, OpenCode, Cline), `.continue/skills/`, `.windsurf/skills/`; the
canonical copy is `.claude/skills/`. Before UI or motion work, read the matching `SKILL.md`:

- iOS / SwiftUI (`apps/mobile-ios`): `apple-design`, `emil-design-eng`, `write-swift`; motion — `animate`, `review-animations`.
- Web UI: `emil-design-eng`, `mobile-native`, `animate`, `pick-ui-library`, `ask-sonner`.

Mirrors are copies: edit only `.claude/skills/`, then run `.claude/scripts/sync-agent-skills.sh`
(`--check` exits 1 on drift). Provenance, license and local patches: `.claude/skills/VENDORED.md`.

Do not call HEADROOM for short tasks or ordinary tool output. Treat MCP servers as optional and fail-safe: their absence must not block implementation. See `.claude/README.md` and `.continue/rules/02-context-routing.md` for platform-specific details.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
