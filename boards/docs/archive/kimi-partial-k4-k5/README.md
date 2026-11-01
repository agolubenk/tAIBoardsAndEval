# Незакоммиченные наброски Kimi по K-4 и K-5 (снапшот 29.10)

Перед удалением ворктри `app-kimi/` и `app-kimi2/` (решение владельца 29.10) сюда скопированы
исходники без `node_modules/` и `dist/` — всё, что в них было незакоммиченного.

- `k4-notion-import-from-app-kimi/notion/` — частичный импортёр Notion из ворктри `app-kimi`
  (ветка `kimi/k4-notion-import`, коммитов не было). Задача K-4 передана Claude 28.10 и закрыта
  канонической реализацией `packages/importers/src/notion` в `boards` (коммит `63bc00d`),
  у канона больше файлов и тесты (`mapping.test.ts`, `mirror.ts`, `reconcile.test.ts` и др.).
- `k5-claude-mem-from-app-kimi2/` — частичный читатель claude-mem из ворктри `app-kimi2`
  (ветка `kimi/k5-claude-mem`, коммитов не было; там же был изменён `pnpm-lock.yaml` — не сохранён,
  это артефакт установки). Задача K-5 передана Claude 28.10 и закрыта пакетом
  `packages/claude-mem-reader` в `boards` (коммиты `63bc00d`, `6ead678`).

Обе ветки `kimi/k4-notion-import` и `kimi/k5-claude-mem` остаются в репозитории `boards`
(голова `46ef6f7`, без собственных коммитов). Для волны 2 (K-6, K-7) ворктри создаётся заново —
правила в `boards/docs/kimi-tasks.md`.
