# Роль 3 — Фронтенд (`frontend`)

Сначала прочитай `../COMMON.md`, потом этот файл. `$H`, `$C` — как в COMMON.

**Ты:** `apps/frontend`, `apps/landings`, `UI-Kit`, дизайн и вёрстка, линзы «фронтенд» и «дизайн» на PR. Включённые
скиллы: `react-feature` и дизайн-набор (`animate`, `emil-design-eng`, `apple-design`, `mobile-native` и др.). Лес —
HR Helper / Lavaeon.

**Принимаешь от:** d7 (`$C/hr-helper-v2-d7.md`, файлы — `$C/hr-helper-v2-d7-files/`, work_state `frontend-t3`).
Список разросся: закрой перенесённое и оставь только живое. Ещё волна 2 просроченных от 87 (`$C/hr-helper-v2-87.md`).
База — LANES-BASE §3.

## Открытое

1. **Гонка кликов в матрице ролей** — Notion «Ошибки» 409dd207a82581b3bc59f8b82b61cf44 (medium), статус «в работе».
   - Код и гейт готовы: ветка `fix/rbac-matrix-race` @ b44e7afd6 запушена, worktree `worktrees/fix/rbac-matrix-race`.
   - Блокер — #444: база должна быть «main с #444». Жди «влито #444, проба ок» от роли 5.
   - Дальше:
     1. rebase на main;
     2. `npm run typecheck`, затем `npx vitest run src/features/rbac-admin src/locales/ruDefaultValuesFlat.test.ts`;
     3. `gh pr create --body-file $C/hr-helper-v2-d7-files/pr-rbac-body.md` — поправь голову в тексте;
     4. карточка t-boards → «на ревью» (`update_task_status` с `link` на PR);
     5. «PR #n, голова, линзы: безопасность (5), продукт (2), бэкенд (4), QA (1)».
   - Живая проверка матрицы — `$C/hr-helper-v2-d7-files/rbac-live.cjs`.
2. **PR #442** (`fix/huntflow-save-error-ux` @ 6739c74de) — текст отказа и подсветка полей Huntflow/Potok.
   - Линзы собраны.
   - Вливается в окне m-440 → m-442 → m-443.
   - После «влито» — проверка прода.
3. **Проверка прода** после окна #440/#442/#443 — по сообщению «влито, проба ок» от роли 5. Форму «Подключение ИИ»
   (#443) делал 87; её замечания 84/d7 и полировка (Notion …819da978fda12ec131ef) — отдельным PR, теперь твоим.
4. **PR #417** (`fix/voice-enroll-wait` @ b21ef29a0) — «Кто это?» на встречах. Approve от 4c, d9, 85. Нужна
   перепроверка QA — запрос роли 1.
5. **Notion 409dd207a825815cbdb7cf8cc25425b3** (P2) — конфликты слияния в `ruDefaultValuesFlat.json`. Можно брать:
   #422 влит.
6. **Notion 402dd207…** (low, искать по «Автоматическ») — на ширине 393 перенос «Автоматическ / и».
7. **Волна 2 просроченных** (`d-overdue-wave2-3010`, владелец выбрал «b») — по одной: Cmd+Z → meetings step 5 →
   profile_extras. Не начато; скоуп — в пункте очереди.
8. **Завести карточку** в t-boards ЗАДАЧИ после PR по матрице: защита матрицы от потерянного обновления двух админов
   (версия / If-Match). Исполнитель — роль 4.
9. **t-boards UI** (TB-14 граф, UI TB-31, TB-11, TB-16) — только по назначению роли 1, держит роль 6.

## Хвосты worktree

Все чистые и запушены:
- `feature/calendar-settings-server`;
- `fix/huntflow-save-error-ux`;
- `feature/cmdk-v1`;
- `fix/pdfjs-ghsa-hq66`;
- `feature/admin-glass-opacity`;
- `fix/rbac-matrix-race`.

В `fix/rbac-matrix-race` неотслеживаемые симлинки `node_modules` и `apps/frontend/node_modules` ведут в
`worktrees/fix/huntflow-save-error-ux/`. Не коммитить. Перед `git worktree remove` удалить сами симлинки. Huntflow
worktree удалишь раньше — сломаются гейты rbac.

## Ловушки (из отчёта d7)

- `PUT rbac/roles/:id/matrix` заменяет строку роли целиком. Клиент шлёт подтверждённую строку плюс неподтверждённые
  клики (`useRoleMatrixSaver.ts`).
- Матрица — вкладка «Матрица прав» на `/admin/settings/roles`. Полоса «Прогресс обучения» перехватывает клики в
  headless — прятать её CSS.
- Браузер Playwright MCP общий. Свой headless — `@playwright/test` с `executablePath` на
  `chromium_headless_shell-1228`. На демо-учётке все не-GET мокать через `page.route`.
- `ruDefaultValuesFlat.json` при rebase не сливать руками — `npm run i18n:generate-ru-flat`.
- `ci-frontend` на main красный (madge). Гейт локально: typecheck (`tsc -b`, не `--noEmit`), vitest related,
  `bundle:check` (entry 231.5 из 260 КиБ).
- Continue читает секреты при загрузке конфига: после ротации токена — Reload Window. Токен не печатать.
- Совет d7 роли 1: на чисто текстовую дельту головы — одна линза по диффу голов, а не все заново.
