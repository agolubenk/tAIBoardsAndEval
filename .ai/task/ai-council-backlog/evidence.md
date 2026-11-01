"# Evidence — ai-council-backlog

## Команды и результаты

| Команда | Результат |
|---|---|
| `python3 .ai/task/ai-council-backlog/fetch_notion.py` | PASS — tasks 261 + bugs 59 = 320 карточек; raw.json (936 KB), matches.json (61 матч) |
| `python3 infra/ai-council/notion.py` (диагностика) | PASS — интеграция «123 (bot)»; S1-поля есть в обеих базах; гварды Status/Half-baked работают |
| `python3 probe2.py` / `probe3.py` / `probe4.py` / `probe6_titles.py` | PASS — контекстные сканы заголовков/тел по AI-лексике; см. выводы в §3-4 BACKLOG.md |
| `python3 probe5_fncheck.py` | PASS — предметный маркер консилиума в 7 карточках, ни одной карточки-субъекта |
| `python3 probe_tags.py` | PASS — тег `найдено-консилиумом`: 3 карточки |
| `python3 probe7_hb.py` | PASS — half_baked=1: 8 карточек (в перечне 1); agent-reach half_baked=0 |
| `git diff --stat docs/plans/BACKLOG.md` | PASS — пусто (замороженный файл не тронут) |
| `git check-ignore .ai/task/ai-council-backlog/raw.json` | PASS — игнорируется (.gitignore:120) |

## Изменённые/созданные файлы

- `docs/plans/ai-council/BACKLOG.md` — НОВЫЙ, сгенерированный снимок перечня (88 строк, 16 ссылок на карточки).
- `.ai/task/ai-council-backlog/*` — артефакты задачи (gitignored): brief, fetch-скрипт, сырые дампы, probe-скрипты.

## Проверяемость

Каждое утверждение перечня сводимо к `raw.json` (дамп от 2026-08-19): статус/severity/теги/half_baked —
поля карточек; «почему здесь» — цитаты тел/комментариев (probe-скрипты воспроизводимы)."