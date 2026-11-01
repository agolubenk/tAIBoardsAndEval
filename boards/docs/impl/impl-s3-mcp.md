# S3 — MCP-слой: экономия токенов и инструменты леса (детали)

Обновлено: 2026-10-27 14:26. Код в `boards/packages/mcp` (ветка `t-boards`, **не закоммичено**). Сводка — `../impl-progress.md`.

## Как устроено

MCP — клиент HTTP API. Встроенный MCP (`apps/api/src/mcp`) и stdio-пакет регистрируют одни и те же инструменты из
`@kaneo/mcp/tools`. API берёт собранный `dist`, поэтому после правок нужен `pnpm --filter @kaneo/mcp build`. Вызовы
идут с bearer-токеном, и лес видит их как `agent`.

- `src/tools/register-tool.ts` — общая обёртка `createRegisterTool`:
  - проверяет аргументы своей zod-схемой;
  - у read-инструментов (список `READ_TOOLS`) расширяет схему параметрами view;
  - ответ API прогоняет через `shapeResult`.

  `run()` кладёт сырой ответ в WeakMap, поэтому текст обратно не разбирается. Write-инструменты отвечают компактным JSON.
- `src/view/` — режимы чтения R-031. Каждый модуль — одна функция, тест рядом.

| Модуль | Что делает |
|---|---|
| `view-options.ts` | `fields`, `summary`, `since`, `ifNoneMatch`, `budget` (150–2500), `format` (toon/json); `splitView` отделяет их от аргументов инструмента |
| `shape-result.ts` | etag всего ответа API. Совпал с `ifNoneMatch` → `{unchanged, etag}` без тела. Иначе since → fields → summary → бюджет; ответ `{etag, data}` |
| `hash-value.ts` | sha256 канонического JSON (порядок ключей не важен), 16 hex |
| `filter-since.ts` | убирает из списков листовые сущности, не менявшиеся после `since`, по самой поздней из меток `updatedAt`/`createdAt`/`felledAt`/`decidedAt`/`consumedAt`; одиночная → `{id, changed:false}` |
| `select-fields.ts` | у сущностей (объектов с `id`) оставляет id, нужные поля и дочерние списки; контейнеры без id (страницы) не трогает |
| `summarize-text.ts` | `description`/`body`/`content`/`text`/`comment`/`reason` → первый абзац, не длиннее 280 символов |
| `fit-to-budget.ts` | R-032: половинит самую длинную строку или список, пока ответ не влезет; обрезанный ответ несёт `truncated` и `fullRef` (имя инструмента и аргументы) |
| `wire-format.ts` | шов под K-3: сигнатуры `encodeResponse`/`TokenCounter` как в `packages/agent-format`. Сейчас JSON и счётчик «символы/4»; `toon` честно откатывается на JSON |

## Инструменты леса (`src/tools/forest/`)

| Инструмент | API | Заметки |
|---|---|---|
| `forest_acquire_lease` | `POST /leases` | `session` обязателен, уходит заголовком `x-t-boards-session`; `groupKey` — общая аренда связки |
| `forest_release_lease` | `POST /leases/release` | старый `fencingToken` → `{released:false}` |
| `forest_request_approval` | `POST /approvals` | запрос «да» на вырубку дерева или сектора |
| `forest_fell` | `POST /fell` | `kind` + `targetId` → `rootId` или `sectorId`; нужен `approvalId` |
| `forest_detect_sectors` | `POST /sectors/detect` | |
| `forest_grow` | `POST /grow` | проект из семян |
| `forest_list_approvals`, `forest_list_logs`, `forest_get_log`, `forest_list_sectors` | `GET …` | read: view, курсоры, `take` ≤ 100 |

Инструмента «ответить на запрос» нет намеренно: «да» даёт только владелец в UI (N-011). Тест это проверяет.

## Проверки (27.10 14:14–14:26)

- `packages/mcp`: `vp test run` → 15 файлов, 80 тестов, pass. `tsc --noEmit` → pass. `vp check` → pass. `build` → `dist` обновлён.
- `apps/api`: `pnpm typecheck` → pass. Unit `vp test run --config vitest.config.ts` → 163 файла, 1184 теста, pass.
- Живой стенд :1337, admin через bearer, MCP 2026-07-28. Скрипт сессии `mcp-probe.mjs` печатает только формы ответов.
  - `tools/list` → 48 инструментов, из них 10 forest; у `list_tasks` есть `budget`.
  - `forest_acquire_lease`:
    - `dev-1` → `fencingToken 1`;
    - `dev-2` → ошибка `lease_conflict: held by dev-1 until …`;
    - release → `{released:true}`.
  - `get_task` с `fields:[title,status]` → `{etag, data:{id,title,status}}`. Повтор с `ifNoneMatch` → `{unchanged:true, etag}`.
  - `list_projects`: 110 токенов целиком, 23 токена с `fields:["name"]`. Пустая страница логов — 17 токенов.
  - Аренда без `session` отклоняется валидацией SDK.
  - На стенде остались синтетические данные пробы: workspace «Probe», проект «Probe forest» (PRB), задача «Probe tree».
- Поменялся формат ответа, и это ломало 6 апстрим-тестов (4 в `register.test.ts`, 3 проверки в
  `tests/api/mcp-stateless.test.ts`). Их ожидания обновлены: `{etag, data}` и компактный JSON.

## Журнал вызовов MCP (R-036, 28.10)

- `packages/mcp/src/tools/register-tool.ts`: хук `onCall` в обёртке. Одна запись на вызов: инструмент, аргументы как
  пришли, `ok`, байты и токены o200k ответа, миллисекунды. Хук считает токены, только если он задан; упавший хук пишет в
  stderr и ответ не ломает.
- `apps/api/src/mcp/tools.ts` → `journalCall`: строка `agent_journal` с `action = mcp.call`, `target = mcp_tool/<имя>`,
  `outcome` `allowed` или `denied` (ошибка инструмента), актор `bearer:<userId>`. `workspace_id` пустой: workspace агент
  называет сам, неверный не должен терять строку на внешнем ключе.
- `apps/api/src/mcp/call-detail.ts`: в `detail` — `{bytes, tokens, ms, args}`. Аргументы проходят `@kaneo/redact` (K-2)
  до обрезки, обрезка — по уже экранированной длине, чтобы JSON влезал в 2000 символов журнала целиком.
- Проверки 09:09–09:13: unit `call-detail.test.ts` 4, MCP `register-tool.test.ts` 3 (пакет — 96 из 96), интеграционный
  `mcp-call-journal.test.ts` 1 (отказ API 403 с секретом в `taskId` → `denied`, секрет заменён меткой). Мутанты: без
  `onCall` в хосте → красный; наивная обрезка → красный. API unit — 168 файлов, 1209 тестов, pass.
- Живьём 09:12: одна `../tools/mcp-probe.mjs` дала 23 строки `mcp.call` по 12 инструментам, например `list_projects`
  3674 байта / 1283 токена.
- Зазоры: вызов, который SDK отклонил по схеме (например, аренда без `session`), до обёртки не доходит и в журнал не
  попадает. Чтения журнала через API пока нет — только SQL. Стоимость по задаче (R-036) ещё не считается: нужна цена
  модели, а её клиент не сообщает.

## Открытое

- ~~K-3~~ — подключён 28.10, откат TOON → JSON пишется в журнал (`mcp.format_fallback`). По умолчанию — дешевле из TOON
  и JSON, см. `impl-s4b-card-fields.md`.
- R-034: набор инструментов по роли (роль + не больше 5 сверх) — готово 28.10, `impl-r034-tool-scope.md`.
- ~~R-031: пакет контекста и поиск с выдержками~~ — готово 28.10, `impl-r031-context.md`.
- ~~Fencing и R-022 для записей kaneo~~ — сделано в S4, MCP передаёт заголовки аренды.
- Ошибки инструментов пока pretty JSON (`errorResult` апстрима); ошибки валидации SDK приходят текстом.
