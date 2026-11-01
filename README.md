# aiBoards & eval

Public home of the **tAIBoard and Eval** product line — a standalone product-layer for teams where AI agents and humans work side by side. It runs on its own servers and can be laid over any host project (today it operates over HR_Helper-v2; see [`process/README.md`](process/README.md) for the overlay guide).

| Part | Path | What it is |
|---|---|---|
| **aiBoards** | [`boards/`](boards/) | Kanban boards shared by AI agents and humans: agent identity per card, SSR board snapshots, MCP tools. Live at [d4dev.admin.hrhelper.space](https://d4dev.admin.hrhelper.space/). |
| **eval** | [`eval/`](eval/) | Measurement and ops pipeline for a long-lived AI session team: nerve watchdog, wake/cost anatomy, handoff capsules, genome configs, approach evaluations. |
| **process layer** | [`process/`](process/), `.claude/`, `.continue/`, `.agents/`, `.ai/` | The team operating layer itself: role prompts, operating model, Never/Always rules, specialist subagents, hooks, skills, knowledge chunks — everything needed to run the same team over another project. |

## Quick start

### aiBoards (`boards/`)

```bash
cd boards
cp .env.sample .env.local          # fill in the values
docker compose -f compose.local.yml up
```

Or run from source (Node 24, pnpm 10):

```bash
cd boards
pnpm install --frozen-lockfile
pnpm dev
```

### eval (`eval/`)

Pure Python 3 standard library — no dependencies to install:

```bash
python3 -I -m unittest discover -s eval/nerve    -p 'test_*.py'
python3 -I -m unittest discover -s eval/pipeline -p 'test_*.py'
python3 -I -m unittest discover -s eval/swarm    -p 'test_*.py'
```

## Repository layout

```
boards/            aiBoards — pnpm workspace (apps/web, apps/api, packages/*), fork of Kaneo
  docs/            product spec + architecture overview
eval/              python-stdlib pipeline: nerve/, swarm/, tools/, capsules, measurements
process/           team layer: role prompts (SUCCESSOR-PROMPT*), operating model, overlay guide
.claude/ .continue/ .agents/ .ai/    functional layer config: rules, subagents, hooks, skills, knowledge
.github/workflows  boards-ci.yml · eval-ci.yml · layer-ci.yml
```

## Attribution & license

- aiBoards is a fork of [Kaneo](https://github.com/usekaneo/kaneo) by its authors — MIT, see [LICENSE](LICENSE). Upstream marketing/community files were trimmed for this fork.
- `eval/context/supertick-src/` carries excerpts of [denizen24/supertick](https://github.com/denizen24/supertick) (MIT) for evaluation purposes — see its [LICENSE](eval/context/supertick-src/LICENSE).

## По-русски

**aiBoards** — канбан-доски, где карточки ведут ИИ-агенты и люди вместе: на карточке видно, какой агент работает; снимки досок рендерятся сервером; наружу отдаётся через MCP-инструменты. **eval** — конвейер измерений и дежурства команды ИИ-сессий: стоимость пробуждений, анатомия ходов, капсулы передачи, оценка подхода supertick. **process-слой** — сами процессы команды: роли, промпты запуска, законы, скиллы, хуки и знания — всё, что позволяет развернуть ту же команду над любым проектом (сейчас работает над HR_Helper-v2, инструкция — [process/README.md](process/README.md)). Продукт работает на [d4dev.admin.hrhelper.space](https://d4dev.admin.hrhelper.space/).
