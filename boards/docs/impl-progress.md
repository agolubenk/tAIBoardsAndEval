# t-boards — ход реализации

Обновлено: 2026-10-29 09:35 (наведение порядка: детали шагов переехали в `impl/`, заменённые документы — в `archive/`, ворктри Kimi удалены). Передача наследнику — `../supertick-eval/HANDOFF-2026-10-28.md` (старый `handoff-2026-10-28.md` отменён, лежит в `archive/`). Спека — `t-boards-spec.md` (v0.3). Задачи Kimi — `kimi-tasks.md`. Детали шагов — в
`impl/impl-*.md`. Что осталось до перехода, решения владельца и субдомен — `impl-remaining.md`. Карта папки — `README.md`.

## Шаги Claude

| Шаг | Что | Статус | Детали |
|---|---|---|---|
| S1 | Подъём форка kaneo: Postgres `compose.t-boards.yml` (127.0.0.1:5433), секреты через `*_FILE`, локальный admin/admin | готово | — |
| S2 | Модель леса: схема и миграции 0064–0066, lease и fencing (R-026), «да» владельца (R-022, N-011), вырубка, логи, секторы, рост из семян, журнал агентов | готово | `impl/impl-s2-forest.md` |
| S3 | MCP-слой: режимы чтения R-031, бюджет R-032, 10 инструментов леса | ядро готово, хвосты открыты | `impl/impl-s3-mcp.md` |
| S4 | Права агента на маршрутах kaneo: аренда и fencing для записей `agent` (AC-010), запреты R-022 (удаление, правка описания владельца; закрытие и приоритет — через «да») | готово; HIGH по Content-Type закрыта 28.10; зазоры 1–6 и 8 описаны | `impl/impl-s4-rights.md` |
| 4 | Поля карточки R-024 (Notion и агента), запрет аренды half-baked, MCP `forest_get/set_card_meta`; формат ответа MCP — дешевле из TOON и JSON | готово 28.10 | `impl/impl-s4b-card-fields.md` |
| MCP | Журнал вызовов MCP (R-036): инструмент, аргументы через K-2, байты, токены, время | готово 28.10 | `impl/impl-s3-mcp.md` |
| R-023 | История карточки (триггеры БД, миграция 0069) и откат одной правки одним действием (AC-009); откат — только люди | готово 28.10 | `impl/impl-r023-history.md` |
| R-034 | Набор инструментов по роли (заголовок `x-t-boards-role`), `tools_find` — не больше 3 за вызов и 5 на сессию, `tools_call`; миграция 0070 (AC-013) | готово 28.10 | `impl/impl-r034-tool-scope.md` |
| R-031 | Контекст-пакет карточки одним чтением (`forest_get_context`), поиск с выдержками, бюджет держится и без длинного текста | готово 28.10 | `impl/impl-r031-context.md` |
| UI | Страница «Лес» (деревья, секторы, брёвна и семена, запросы «да», аренды), боковая панель карточки, сброс черновиков диалогов | готово 28.10 | `impl/impl-ui.md` |
| K-4 | Импортёр Notion `packages/importers/src/notion` (передан Claude владельцем 28.10) | готово 28.10 | `impl/impl-s5-import-memory.md` |
| S5 | Импорт Notion как зеркало: обновление по `last_edited_time`, поля агента сохраняются, миграция 0071 | готово 28.10; ограничения 1–5 описаны | `impl/impl-s5-import-memory.md` |
| K-5 | Читатель claude-mem (только HTTP воркера), раздел «Память» карточки, `GET …/cards/{taskId}/memory` | готово 28.10; MCP `forest_get_card_memory` — 29.10 | `impl/impl-s5-import-memory.md`, `impl/impl-r037-work-state.md` |
| reopen | Переоткрытие закрытой карточки агентом — только через «да» `reopen_task` (решение владельца `d-tb-reopen`) | готово 28.10, коммит `3eacffa` | `impl/impl-s5-import-memory.md` |

## Kimi (на 28.10 15:47)

- K-1 `kimi/k1-ru` `4ba3f6b`, K-2 `kimi/k2-redact` `9f0f948`, K-3 `kimi/k3-agent-format` `7ef4827` — перенесены в дерево
  `t-boards` и вошли в коммит `63bc00d`. Отчёты — `kimi-reports/K-1..3.md`.
- K-3 подключён через `packages/mcp/src/view/wire-format.ts`; поверх него — выбор дешёвого формата (см. шаг 4).
- K-4 и K-5 владелец 28.10 передал Claude; сделаны в `t-boards`, ветки Kimi (`app-kimi`, `app-kimi2`) не трогались.

## Проверки (28.10, после обеда)

- После K-4, S5 и K-5, перед коммитом `63bc00d`: интеграционный набор целиком через `tools/run-int.sh` — 1655 из 1655,
  pass. Typecheck api и web, `tsc` пакетов `mcp`, `importers`, `claude-mem-reader` — pass.
- Переоткрытие (`3eacffa`, 15:46): unit 20 из 20, интеграция 12 из 12, `packages/mcp` 104 из 104, typecheck api, web и mcp,
  `vp check` всего репозитория — pass. Подробно — `impl/impl-s5-import-memory.md`.

## Проверки (28.10, утро)

- 08:52–08:59: API unit → 167 файлов, 1205 тестов, pass; `typecheck` → pass; `openapi:check` (09:02) → up to date.
- `packages/mcp` → 93 из 93, pass; `tsc` и сборка → pass.
- Интеграционные: card-meta 6, agent-rights 10, lease 3, felling 4, mcp-banned-user 1, `tests/api/mcp-*` 30 — pass.
- Мутанты: проверка half-baked в аренде → 1 красный; выбор дешёвого формата → 1 красный; восстановлены.
- Живые пробы 08:59: `mcp-probe-s4.mjs` — все шаги как ожидалось (`impl/impl-s4-rights.md`); `mcp-wire-measure.mjs` — 3835
  токенов по умолчанию против 4329 TOON и 3952 JSON (`impl/impl-s4b-card-fields.md`).
- Полный интеграционный набор: прошлый прогон (ночь на 28.10) — 146 файлов, 1632 теста, 1 флак `github-import-bounds` (отдельно
  32 из 32 pass). Прогон 09:09 — 147 файлов, 1638 тестов, pass, без флака. После R-023 (09:48) — 149 файлов, 1643
  теста, pass. После R-034 (09:59) — 150 файлов, 1645 тестов, pass; проверки R-034 — `impl/impl-r034-tool-scope.md`.

## Проверки (27.10)

- API: интеграционный набор целиком → 145 файлов, 1622 теста, pass. Unit → 163 файла, 1184 теста, pass. `typecheck` → pass.
- `packages/mcp`: 15 файлов, 80 тестов, pass. `tsc` → pass, `vp check` → pass.
- Живой стенд: MCP через bearer — аренда, конфликт сессий, etag «не изменилось», `fields`. Цифры в `impl/impl-s3-mcp.md`.
- S4, 27.10 19:28–19:34:
  - `forest-agent-rights.test.ts` → 8 из 8 pass; мутант без guard-а → 7 из 8 красные;
  - API unit → 165 файлов, 1199 тестов, pass; `typecheck` → pass;
  - `packages/mcp` → 16 файлов, 86 тестов, pass; `tsc` и `vp check` → pass;
  - `openapi:check` → up to date.
  - Результат полного интеграционного прогона потерян вместе со scratchpad — перепрогнать. Девятый тест (полное тело
    `update_task`) не запускался. `dist` MCP не пересобран.

## Стенд

- web http://localhost:5173, API http://localhost:1337, вход admin/admin (`admin@t-boards.local`).
- Postgres в `compose.t-boards.yml`, 127.0.0.1:5433. В dev-базе применены миграции до 0071 (хвост 0069 — вручную, см. `impl/impl-r023-history.md`; 0070 и 0071 применил dev-сервер сам, сверено 28.10 15:48).
- На 28.10 15:47 подняты Postgres, API dev-сервер на :1337 и web на :5173 — стенд готов к ручной проверке.
- Скрипты (`zsh`/`node`): `tools/run-int.sh` (интеграционные тесты, пароль не печатает), `tools/mcp-probe.mjs` (живая
  проба MCP), `tools/mcp-probe-s4.mjs` (права агента и поля карточки), `tools/mcp-wire-measure.mjs` (токены по форматам),
  `tools/history-probe.mjs` (история и откат, R-023), `tools/tool-scope-probe.mjs` (роли и токены, R-034).
- Синтетика пробы MCP: workspace «Probe», проект «Probe forest», задача «Probe tree».

## Состояние кода

Всё в `boards`, ветка `t-boards`. Локальные коммиты (решение владельца `d-tb-commit`):

- `63bc00d` — лес, права агента, MCP, поля и контекст карточки, UI, K-1…K-5, S5;
- `3eacffa` — переоткрытие через «да».

Единственный remote — `upstream` (kaneo). Наружу не пушится никогда. Новые файлы:

- `apps/api/src/forest/**`, `apps/api/src/mcp/tool-scope/**`, `apps/api/src/import/notion-mirror/**`, `database/forest-schema.ts`, миграции 0064–0071, `scripts/seed-local-admin.ts`;
- `packages/mcp/src/view/**`, `src/tools/forest/**`, `src/tools/register-tool.ts`;
- `tests/api-integration/forest-*.test.ts`, `helpers/forest.ts`;
- пакеты K-1…K-5 (`packages/agent-format`, `redact`, `importers/src/notion`, `claude-mem-reader`), `pnpm-lock.yaml`;
- web: `components/forest/**`, `components/task/forest/**`, `hooks/use-reset-on-open.ts`.

Правки апстрима:

- `register.ts` — общая обёртка и forest-инструменты;
- `register.test.ts`, `tests/api/mcp-stateless.test.ts` — новый формат ответа;
- схема, `index.ts`, `openapi.json`, вход на web.
