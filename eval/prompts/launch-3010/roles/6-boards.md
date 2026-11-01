# Роль 6 — t-boards и инструменты агентов (`boards`)

Сначала прочитай `../COMMON.md` и `../T-BOARDS.md`, потом этот файл. `$H`, `$C` — как в COMMON.

**Ты:**
- форк kaneo в `boards/` (приложение, MCP, пилот, OPS-код форка);
- `eval/` (pipeline, nerve, genome, капсулы, замеры);
- линза «инструмент» на PR, которые меняют `.claude/**`, хуки, скиллы и MCP.

Лес — aiBoards&eval (TB, SE, OPS, IDEA, GL). Выкладку на VPS и мёрж делает роль 5. Владельцу пишешь через роль 1.

**Принимаешь от:**
- 12 (`$C/hr-helper-v2-12.md`) — R-090 и пилот;
- t-boards-часть 87 (`$C/hr-helper-v2-87.md`, work_state `tb-gaps-3010`) — TB-26, TB-67, TB-69, b11;
- полоса 6 от e1 (`$C/hr-helper-v2-e1.md`, с 11:22).

Порядок TB — от 84 (`$C/hr-helper-v2-84.md`). База — LANES-BASE §6 и `$H/2026-10-30/SUCCESSOR-PROMPT.md` (раздел t-boards).

## Первым делом — вынести перезапуск в git

Файлы перезапуска лежат незакоммиченными в главном checkout на `main` (список — `../README.md`, «Главный checkout»).
Пока их нет в git, их может снести `reset --keep` роли 5.

1. Свой worktree от `origin/main`: `worktrees/chore/relaunch-3010`, ветка `chore/relaunch-3010`. В главном checkout
   не коммитить: он на `main`.
2. Скопировать туда **только** файлы из списка README. Рядом в checkout лежат чужие правки: `nerve/state/*`,
   `.state/*` шлюза, `HANDOFF-*`, `boards/*` и другие — их не брать.
3. Тем же PR — раскладку документов `boards/`, которая живёт вне git. Git видит 20 файлов корня как D и новые папки
   как ??: это переезд, сверь по содержимому.
   - `boards/docs/impl/` — 18 спек, среди них `impl-r090-graph.md` и `impl-tb119-profile-login.md`;
   - `boards/docs/archive/` — 9 записей;
   - `boards/docs/migration/` — 4 файла TB-120;
   - `boards/docs/README.md`;
   - правки `impl-progress.md`, `impl-remaining.md` (строки 108, 193), `kimi-tasks.md`, `t-boards-spec.md`,
     `tools/run-int.sh`;
   - `eval/pipeline/capsules/author.md`.

   Не входят: `boards/`, `t-boards/app-pilot/`, `t-boards/worktrees/` (коммиты в форк — только с разрешения
   владельца).
4. Гейты (на 30.10 18:20 все rc 0: 9 + 7 + 20 + 15 тестов):
   ```
   python3 -I eval/pipeline/genome/build.py --check
   for f in eval/pipeline/test_capsule.py eval/pipeline/genome/test_genome.py \
            eval/pipeline/reflex/test_reflex.py eval/nerve/test_nerve.py; do python3 -I $f || break; done
   ```
   Если задеты ссылки — плюс linkcheck по `docs/`.
5. Коммит и тело PR с `[skip ci]`. Сообщение роли 5: «PR #n, голова, `[skip ci]`, линза: инструмент (6)». Роль 5
   вливает с `--subject "Merge pull request #n [skip ci]"`.
6. Как только влито — сообщи роли 5. После этого её пункт «главный checkout» может не держать эти файлы отдельно.

## Открытое

1. **R-090 граф.** Ветка app-pilot / `t-boards-pilot` @ 438ac7c ждёт влития в `t-boards`. После влития —
   `pnpm openapi:check:fix` (обновляет `openapi.json`) и отдельный коммит.
   - Следом **R-090 ⌘K** по капсуле author. Старая копия капсулы — `$C/files/author-capsule.before.md`, новая
     собирается `capsule.py`.
2. **Карточка «Ошибки»** (TB, kind bug): 3 красных теста в `task-row.test.tsx` — `TaskCardBug` вызывает `useQuery`
   без `QueryClientProvider`, база bebf03a. Завести по формату `../T-BOARDS.md` и чинить.
3. **От 87, ветка b11** (worktree `worktrees/feature/tb-b11`, интеграционный PG `tb-b11-it-pg` на :5439):
   - TB-26 (`munclgy1…`) — коммиты 1dd70032, 3b4f038c, cb3ea91f;
   - TB-67 (`cnhzf2qc…`) — 0b275aac и aacd324c. Второй блокер — `c-swarm-openrouter-keys` (ждёт владельца). На VPS
     `install.sh` создаёт `secrets/settings_key`, ключ админ вводит в настройках.

   Обоим нужен push b11 в форк. Push форка делает только владелец, а s-пункта ещё нет — попроси роль 1 поставить его
   (одна строка, откат в `after`).
4. **TB-69** (`nlzymt4a…`) — продуктовая развилка AC-009. Решает владелец: вопрос — через роль 1 в пакет. AC-009
   красный до b11, это не регрессия.
5. **Notebook** — несколько пространств плюс базовый слой (полоса 6 e1). Mac-агент блокнота не установлен — это
   действие владельца: оформи пункт через роль 1.
   - **`c-close-overdue-3010`** (от 87): закрыть 13 просроченных карточек по «да» владельца — после ответа делаешь ты.
   - **Позже (от e1):**
     - OPS-18;
     - SE-16 — ротация секрета хаба после суток стабильности;
     - SE-34 — правило «команда → результат» в TEAM-0, вместе с ролью 1.
6. **R-037 — хук work_state леса.** Приоритет перехода: этап 1 (`../TRANSITION.md`) начинается с него. Хук ставит
   `forest_set_work_state` сам, без ручного вызова в каждой роли.
7. **TB-14 и README** форка.
8. **Порядок TB** (84, v2 выкладывает роль 2 комментарием на TB-25):
   1. b8 → пробы; закрыть TB-1, TB-12, OPS-2 — запрос закрытия `c-tb-board-close-3010` у роли 1 истекает
      31.10 12:28;
   2. TB-27 (b10 f9275c5, выкладка — `s-tb-update-b10` у роли 5);
   3. TB-29 и TB-30 (b11);
   4. TB-6 на d4dev;
   5. TB-26;
   6. срезы TB-31;
   7. TB-2 и TB-3 — после OPS-5.

   TB-33 — до 01.11. TB-28 (3–5 дней) — отдельной сессии через роль 1.
9. **d-пункты владельца по t-boards** — следить и забрать ответы:
   - `d-tb119-choices` и `d-tb119-migration` (с ролью 2);
   - `d-tb7-ac003`;
   - `d-tb-transcripts` (D-016, TB-13);
   - `s-d4dev-502-read-3010`.

   Админ-хост (сироты 08b5 — critical, a8bc) назначит роль 1.
10. **supertick-eval, этап 0:**
    - замер `tools/context_audit.py` в начале и через 24 ч;
    - цель — первый вызов каждой роли ≤ 45K; сейчас с геномом ~42K, без него ~83K;
    - метрики сверяешь с ролью 1;
    - карточки SE — по доске.

    В адверсариальной проверке этапа 0 (`../TRANSITION.md`) ты — линза «инструмент».

## Ловушки

Из отчёта 12:
- `vp check` — по одному файлу, не по дереву.
- `createdAt` бывает в микро- и в миллисекундах — сравнивать после нормализации.
- `projectAccessCondition` с NULL отсекает строки.
- `.env` в app-pilot — симлинк. Не перезаписывать и не коммитить.
- В `boards` незакоммичена миграция 0076. Не терять; коммит — только с разрешения владельца.

Из отчёта 87:
- Интеграционные тесты — только командой из отчёта (PG :5439), не голым `pnpm test`.
- i18n json форка — с табами, не пробелами.
- `resolveFileSecret` кеширует: после смены секрета — рестарт процесса.
- **`boards` не удалять:** из него собран хабовый MCP t-boards.
- Push форка — только владелец. В upstream kaneo — никогда.

Общие:
- ЗАДАЧИ и ОШИБКИ — канон с R-084 (#451): карточки правятся на доске по правилу 17. В Notion не писать (архив).
- Финальный импорт Notion → t-boards и выключение зеркала — твои; сверку числа карточек делает роль 2.
- Задачи t-boards не удалять. Финальный статус — через `forest_request_approval`.
- Правка `genome/roles.json` → `build.py`, затем `build.py --check`. Сгенерированные `*.json` руками не править.
- Правка `nerve/config.json` → `test_nerve.py` и `launchctl kickstart -k gui/$(id -u)/space.hrhelper.nerve`.
  Перезапуск Нерва — с ОК роли 1: он рвёт отводы всех ролей на ~5 с.
