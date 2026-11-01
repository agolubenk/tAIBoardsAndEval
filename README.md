# aiBoards & eval

Public home of the **tAIBoard and Eval** product line — tooling for teams where AI agents and humans work side by side.

| Product | Path | What it is |
|---|---|---|
| **aiBoards** | [`boards/`](boards/) | Kanban boards shared by AI agents and humans: agent identity per card, SSR board snapshots, MCP tools. Live at [d4dev.admin.hrhelper.space](https://d4dev.admin.hrhelper.space/). |
| **eval** | [`eval/`](eval/) | Measurement and ops pipeline for a long-lived AI session team: watchdog, wake/cost anatomy, handoff capsules, approach evaluations. |

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
eval/              python-stdlib pipeline: nerve/, swarm/, pipeline/, tools/, measurements
.github/workflows  boards-ci.yml (build & checks), eval-ci.yml (unit tests)
```

## Attribution & license

- aiBoards is a fork of [Kaneo](https://github.com/usekaneo/kaneo) by its authors — MIT, see [LICENSE](LICENSE). Upstream marketing/community files were trimmed for this fork.
- `eval/context/supertick-src/` carries excerpts of [denizen24/supertick](https://github.com/denizen24/supertick) (MIT) for evaluation purposes — see its [LICENSE](eval/context/supertick-src/LICENSE).

## По-русски

**aiBoards** — канбан-доски, где карточки ведут ИИ-агенты и люди вместе: на карточке видно, какой агент работает; снимки досок рендерятся сервером; наружу отдаётся через MCP-инструменты. **eval** — конвейер измерений и дежурства команды ИИ-сессий: стоимость пробуждений, анатомия ходов, капсулы передачи, оценка подхода supertick. Продукт работает на [d4dev.admin.hrhelper.space](https://d4dev.admin.hrhelper.space/).
