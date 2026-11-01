# Капсула: author

**Цель.** R-090, последняя панель — ⌘K: быстрый переход и действия по карточкам, секторам и вкладкам леса с клавиатуры. Сначала выяснить, что уже есть в kaneo (палитра команд, поиск), и закрыть разрыв до R-090 малым срезом. Работа в worktree t-boards/app-pilot (ветка t-boards-pilot); вливает в t-boards сессия Б4.

**Приёмка.**
- в отчёте сверка: что из ⌘K уже даёт kaneo, чего не хватает для R-090 (с путями к коду)
- ⌘K/Ctrl+K открывает палитру на любой странице пространства; переход к карточке, сектору и вкладке леса; без мыши (Tab/стрелки/Enter/Escape)
- поиск идёт через API с доступом: карточки закрытых проектов не находятся — интеграционный тест с мутантом без фильтра доступа
- код палитры не на критическом пути (lazy), экран 400 px без горизонтального скролла
- pnpm typecheck (api, web), vp check, i18n:check, openapi:check:fix; отчёт boards/docs/impl/impl-r090-cmdk.md и строка R-090 в impl-remaining.md

**Решения.**
- граф связей готов: вкладка «Граф», GET /forest/{ws}/graph, коммит 438ac7c в t-boards-pilot, ждёт вливания (boards/docs/impl/impl-r090-graph.md)
- доступ к карточкам — projectAccessCondition и на выборке, и на другом конце связи; NULL-проект он пропускает — рядом isNotNull (apps/api/src/forest/graph/graph-links.ts)
- курсор (createdAt, id): в базе микросекунды, в курсоре миллисекунды — обе стороны через date_trunc('milliseconds') (apps/api/src/forest/graph/graph-cards.ts)
- помощники ограниченного участника — addRestrictedMember/asMember (tests/api-integration/helpers/forest-members.ts)
- 3 теста list-view/task-row.test.tsx красные с bebf03a (TaskCardBug зовёт useQuery без QueryClientProvider) — это срез Б4, не автора (boards/docs/impl/impl-r090-graph.md)
- адверсариальную проверку для t-boards опускаем (HANDOFF-2026-10-28.md §5)

**Механика.**
- /Users/agolubenko/Desktop/Development/HR_Helper-v2/t-boards/app-pilot [t-boards-pilot] 438ac7c49, грязных 0
- стенд: t-boards-postgres-1 Up 40 minutes (healthy)

**Следующий шаг.** Проверить, влил ли Б4 коммит 438ac7c: git -C boards merge-base --is-ancestor 438ac7c t-boards. Если да — cd t-boards/app-pilot && git switch -C t-boards-pilot t-boards (репозиторий общий, fetch не нужен); если нет — работать поверх 438ac7c. Затем grep -rilE 'cmdk|command' apps/web/src/components, прочитать boards/docs/t-boards-spec.md R-090 и apps/api/src/search*. Стенд: в app-pilot ln -s ../app/.env .env, в фоне pnpm --filter @kaneo/api dev и pnpm --filter @kaneo/web dev; после проверки остановить свои процессы и удалить ссылку .env.

**Не делать.**
- не пушить; коммитить только в t-boards-pilot, не в t-boards
- не трогать boards (там сессия Б4: бандл и VPS), deploy/vps/, Dockerfile.kaneo, app-kimi, app-kimi2
- npx vitest из пакета нельзя; миграции сверять с apps/api/drizzle/, не с dev-базой (в boards лежит незакоммиченная 0076 Б4)
- vp check со списком файлов или каталогов падает «Expected at least one target file» — проверять по одному файлу; полный vp check гоняет pre-commit
- больше двух субагентов или workflow — только с «да» владельца

**Оригиналы.**
- eval/HANDOFF-2026-10-28.md §4, §5
- boards/docs/impl/impl-r090-graph.md, boards/docs/impl/impl-r090-pulse.md
- boards/docs/impl-remaining.md (строка R-090)
- boards/docs/t-boards-spec.md R-090
