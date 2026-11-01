# CLAUDE.md — aiBoards & eval repo map

Two products, one repository:

- `boards/` — **aiBoards**: kanban for human + AI-agent teams. pnpm workspace (vite-plus), fork of Kaneo (MIT). Own `CLAUDE.md`/`AGENTS.md` inside.
- `eval/` — **eval**: python-stdlib ops/eval pipeline for the AI session team (nerve watchdog, wake/cost anatomy, capsules).

## Commands

boards (inside `boards/`):

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm i18n:check && pnpm openapi:check
pnpm dev                                   # from-source dev
docker compose -f compose.local.yml up     # local stack (needs .env.local)
```

eval (from repo root, Python ≥ 3.10, stdlib only):

```bash
python3 -I -m unittest discover -s eval/nerve    -p 'test_*.py'
python3 -I -m unittest discover -s eval/pipeline -p 'test_*.py'
python3 -I -m unittest discover -s eval/swarm    -p 'test_*.py'
```

## CI

- `.github/workflows/boards-ci.yml` — lint / typecheck / unit / build / i18n / openapi on `boards/**`
- `.github/workflows/eval-ci.yml` — unittest on `eval/**`

## Rules of the road

- Runtime state is never committed: `eval/nerve/state/`, `eval/swarm/state/`, `.env*`, `.secrets/`, `node_modules`, build outputs.
- eval stays stdlib-only python; adding a dependency is a decision, not an accident.
- DB migrations (`boards/apps/api/drizzle/`) and deploy steps are owner-approved changes.
- PR checks green (boards and/or eval, by touched paths) before merge to `board-agents`.
