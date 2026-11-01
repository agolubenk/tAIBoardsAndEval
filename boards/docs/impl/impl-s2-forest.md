# S2 — модель леса, lease, «да» владельца (детали)

Обновлено: 2026-10-27 14:07. Код в `boards` (ветка `t-boards`, **не закоммичено**). Сводка — `../impl-progress.md`.

## Схема и миграции (`apps/api/src/database/forest-schema.ts`)

| Миграция | Что |
|---|---|
| `0064_t_boards_forest.sql` | `task_lease`, `owner_approval`, `sector`, `sector_tree`, `felling`, `timber_log`, `seed`, `tree_origin`; `task.revision` + триггер инкремента |
| `0065_t_boards_journal.sql` | `agent_journal` (кто, что, над чем, allowed/denied); GIN-индекс `timber_log.felled_task_ids` |
| `0066_t_boards_cursor_ms.sql` | `owner_approval.created_at`, `timber_log.felled_at` → `timestamp(3)` |

Почему 0066: курсор страницы несёт JS `Date` (мс), а Postgres хранил мкс. Логи одной вырубки (одна транзакция,
одно `now()`) выпадали со второй страницы. Нашёл интеграционный тест пагинации.

## Домен (`apps/api/src/forest/`)

- `actor.ts` — кто действует.
  - `owner-ui` — cookie-сессия админа инстанса без токена;
  - `member-ui` — cookie-сессия остальных;
  - `agent` — всё, что несёт API-ключ или bearer. Метка сессии — заголовок `x-t-boards-session`.
- `lease/` — аренда задачи (R-026).
  - Свой держатель или тот же `groupKey` продлевает аренду с тем же токеном.
  - Аренду, у которой истёк срок, забирают с токеном +1.
  - Конфликт отвечает 409 `lease_conflict` с именем держателя.
  - Release со старым токеном — no-op: `{released:false}`.
- `approval/` — «да» владельца (N-011).
  - Запрос: `treeIds` считает сервер (`fell-targets.ts`), `paramsHash` наружу не отдаётся.
  - Ответить может только `owner-ui`. Агент получает 403 `owner_session_required`, попытка пишется в журнал.
  - Одобрение одноразовое: хэш параметров должен совпасть.
- `fell/` — вырубка (R-028).
  - Одна транзакция: блокировка корней и всех задач, проверка аренд и «да».
  - Затем бревно на каждое дерево, семена, удаление задач и запись в журнал.
  - События `task.deleted` и `task-relation.deleted` уходят после commit.
  - Лимит — 500 задач.
- `sector/` — секторы v1 (`links-v1`).
  - Union-find по связям blocks/related между деревьями, подпись — sha256.
  - Исчезнувшая группа помечается `stale`.
- `grow/` — проект из семян (до 100 семян): задачи в to-do плюс строки `tree_origin`.
- `read/` — логи (поиск по тексту, keyset), лог с семенами, одобрения, секторы. Страница по умолчанию — 20, максимум — 100.
- `task-scope.ts` — задача чужого воркспейса даёт 404, срубленная — 410 `felled`.

## HTTP (`/api/forest/{workspaceId}/…`, OpenAPI перегенерирован)

| Метод и путь | Право |
|---|---|
| `POST leases`, `POST leases/release` | task:update |
| `POST approvals`, `GET approvals`, `POST approvals/{id}/decide` | task:delete (запрос) · сессия владельца (ответ) |
| `POST fell` | task:delete (+ «да», если вызывает не владелец) |
| `POST grow` | project:create + task:create |
| `GET logs`, `GET logs/{id}`, `GET sectors`, `POST sectors/detect` | чтение · task:update (detect) |

## Проверки (27.10 14:05)

- `pnpm --filter @kaneo/api typecheck` → pass.
- `pnpm exec vp check <файлы>` → pass.
- Unit-тесты: `pnpm --filter @kaneo/api exec vp test run src/forest` → 5 файлов, 18 тестов, pass.
- Интеграционные тесты: `tests/api-integration/forest-{lease,felling}.test.ts` → 7/7, pass. Запуск — скрипт сессии:
  - `DATABASE_URL` собирается из `.secrets/postgres_password` внутри процесса и не печатается;
  - база `<POSTGRES_DB>_test` на :5433 создаётся и мигрируется самим harness.
- Полный интеграционный набор API (27.10 14:14) → 145 файлов, 1622 теста, pass.

## Открытое

- Существующие маршруты kaneo (update/delete task) не проверяют аренду, fencing и права агента (R-022).
- `assertFence` (AC-010, отказ записи со старым токеном) пока без HTTP-пути. Ставить его на маршруты kaneo в API, для
  `actor = agent`, а не в MCP. Поправка 27.10 14:26: MCP — только клиент HTTP API, агент с ключом обходит его прямым
  вызовом. Это следующий шаг, S4 в `../impl-progress.md`.
- Секторы видят только явные связи. Сигнал «общие решения» — позже.
