# process — командный слой aiBoards & eval

Процессы и надстройки команды ИИ-сессий (Т-сборка): роли, протоколы, законы, скиллы, хуки и знания — всё, что сегодня работает поверх HR_Helper-v2 на серверах. Здесь это самостоятельный продукт: слой накладывается на host-проект и настраивается под него.

## Состав слоя

| Где | Что |
|---|---|
| `prompts/` | Пусковые промпты команды: `SUCCESSOR-PROMPT.md` (мастер-промпт), `1-QUEUE` (Координатор), `2-CONTROL` (Контроль), `3-F5`, `3-OWNER-QUEUE` |
| `model/` | Операционная модель живого инстанса над HR_Helper-v2: `CLAUDE.md` (DAMS L1), `AGENTS.md`, `ACTION-PLAN.md` — эталон настройки |
| `../.claude/` | Рабочий слой: `rules/` (законы Never/Always, грузятся по `paths:`), `agents/` (субагенты-специалисты), `hooks/` (+ их тесты), `scripts/` (`glm_client.py`, `rag_query.py`, `sync-agent-skills.sh`), `skills/` (канонические скиллы, `VENDORED.md` для вендорных), `memory/` (чанки знаний + `capital.json`), `settings.json` (хуки слоя) |
| `../.continue/`, `../.agents/` | Зеркала слоя для других харнессов (Continue, Codex/Copilot, Cursor, …); регенерируются `sync-agent-skills.sh` |
| `../.ai/` | Процесс папок задач: `templates/` (brief → recon → hypotheses → plan → evidence → cloud-question) и живые дела `task/` |
| `../claude-plugins-official/` | Vendored официальные плагины (лицензии внутри) |
| `../eval/` | Демоны и измерения слоя: Нерв (github/queue/budget источники, кворум, циркадные режимы), swarm, капсулы, геномы ролей, `tools/spawn_session.sh` |

## Как развернуть слой над host-проектом

1. Скопировать в корень host-проекта: `.claude/`, `.agents/`, `.continue/`, `.ai/`, `claude-plugins-official/`, `process/` — или только нужные части.
2. Поправить пути инстанса: в `.claude/rules/*` секции `paths:` сейчас указывают на дерево HR_Helper-v2 (`apps/backend/`, …) — заменить на пути host-проекта.
3. Настроить инстанс: `.claude/settings.json` (хуки), `eval/nerve/config.json` (репозиторий GitHub, роли, `project_dir`, очередь владельца, бюджеты).
4. Прогнать проверки слоя — все должны быть зелёными:
   ```bash
   for t in .claude/hooks/test_*.py .claude/scripts/test_*.py; do python3 "$t"; done
   ```
5. Скиллы править только в `.claude/skills/` (канон); зеркала пересобирает `.claude/scripts/sync-agent-skills.sh` (`--check` ловит расхождение).

## Что в слой НЕ входит (рантайм инстанса, не продукт)

`.claude/memory/session/`, `settings.local.json`, `CLAUDE.local.md`, `.serena/`, `.cmem-projects/`, `graphify-out/`, `.playwright-mcp/`, `agent-transcripts/` — живое состояние сессий, кэши и памяти машин; создаются при работе и не переносятся.
