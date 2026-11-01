# Роль 4 — Бэкенд (`backend`)

Сначала прочитай `../COMMON.md`, потом этот файл. `$H`, `$C` — как в COMMON.

**Ты:** `apps/backend`, `packages/`, `apps/telegram-sessions`, `apps/wiki-collab`, `apps/diarization`, данные и
миграции, merge-guard; линзы «бэкенд» и «данные» на PR. Включённые скиллы: `nestjs-service`, `db-migration`,
`hr-domain`, `incident-debug`. Лес — HR Helper / Lavaeon.

**Принимаешь от:** 4c (`$C/hr-helper-v2-4c.md`, work_state `backend-t3`). Списки `#433 merge-guard …`,
`phase-1.5 company-users-rbac` и остальные — читать, закрытые мёржами закрыть. Ещё PR #446 от 87
(`$C/hr-helper-v2-87.md`). База — LANES-BASE §4.

## Открытое

1. **PR #433 merge-guard** — `fix/merge-guard`, worktree `worktrees/fix/merge-guard`. Голова **74a37e732** запушена.
   - Закрыты 5 находок security-review на b7d171ed5.
   - Проверки: тесты 532 (194 + 338) rc 0; 10 новых обходов падают на 6a082f0e9; мутации пойманы; свипы репо
     (290 npm/make, 916 скриптов) дают те же отказы, что старая голова; проба 433n — 0 расхождений.
   - Дальше:
     1. Тело PR — `$C/files/433-body-r9.md` плюс абзац про 5 находок. Строку «cd в конвейере … строже» исправить:
        теперь это подоболочка.
     2. Комментарий автора.
     3. «PR #433, голова 74a37e732, линзы: безопасность и корректность» → роль 5. QA (тесты и мутанты) → роль 1.
   - На 6a082f0e9 и на 74a37e732 линз ещё нет.
   - MEDIUM 3 (потерянный `cd` в скрипте с диска) оставлен сознательно: строгий режим даёт 12 ложных отказов
     mcp-hub. Напиши это в PR.
   - Пробы 85 — `$C/files/probe433/`.
2. **PR #444 PR-A** — `fix/rbac-legacy-matrix`, worktree `worktrees/fix/company-users-rbac`, голова 3d18fe6ad, база
   `fix/company-settings-manage`.
   - Ждёт «влито #440, проба ок» от роли 5.
   - Потом сменить базу без rebase: `gh api -X PATCH repos/agolubenk/HR_Helper-v2/pulls/444 -f base=main`
     (`gh pr edit` падает на GraphQL).
   - Сообщи роли 5: она сверяет базу и голову и вливает отдельным окном.
   - Влить на старой базе нельзя: коммит уйдёт в ветку #440, а не на прод.
3. **PR #440** (фаза 1 настроек компании, 078c6ed83) — вливает роль 5 в окне.
4. **PR-B — защита учётки владельца.** Не начат, ждёт q1 пакета 20:50 (у роли 1). Цена — около 75–90 строк кода и
   ~120 тестов.
   - Эндпоинты: PATCH `/company/users/:userId`, POST `…/2fa/reset`, PUT `/rbac/users/:userId/assignments`. Правила:
     «себя не отключить», «свои назначения не менять».
   - В тот же PR — комментарий 85 к Notion P0 409dd207a82581c180acd7e714523ae3: PUT/GET matrix и чтение журнала аудита
     без проверки права.
   - Линза безопасности — роль 5: REST и Connect.
   - Фаза 1.5 «мутации только у владельца» — предпроверка 85: `$C/files/p15-precheck.md`.
5. **PR #332** (`fix/diarization-skip-visible`, 8fad5e49f) — 85 дал QA ок; ждёт линз ролей 5 и 3. После мёржа
   удалить локальную `tmp/332-rebased`.
6. **PR #446** (Telegram PR C, голова 4b3adcf6a; был у 87, теперь твой).
   - Линза корректности неполная, живого e2e нет. Доделать — затем «PR #446, голова, линзы» → роль 5.
   - После деплоя — `docker compose build telegram-sessions backend`: старый образ даёт UNIMPLEMENTED.
7. **Хвосты без PR:**
   - комментарии в `infra/scripts/dev-ai/ai-tooling-pipeline.sh`, строки 6 и 26 — из-за них 8 ложных отказов
     `ai-pipeline:*` в merge-guard;
   - контракт `fields` у URL_NOT_PUBLIC / NEEDS_FORM_SECRET после #440 и #442;
   - 409 на `voiceprints/enroll` во время processing — 0,5 дня, карточку заводит роль 1;
   - проверка «дыр» hh OAuth и токена Notion компании — роли 1;
   - `d-c79f-article-3010` — оценка статьи (входящее c79f), назначает роль 1;
   - `s-hf-autorefresh-3010` — итог от роли 5 к тебе;
   - защита матрицы от потерянного обновления (If-Match) — карточку заведёт роль 3 после своего PR.

## Хвосты worktree

`worktrees/feature/fim-tiel-coder` хранит локальный коммит 7eae11803, не запушенный, а upstream у ветки ошибочно
`origin/main`. **Голый `git push` там не делать.** Работа уже в #445; worktree удалить после мёржа #445. Остальные 10
worktree чистые.

## Ловушки (из отчёта 4c)

- Bash-инструмент здесь — **zsh**: `$o` не делится на слова, `true | cd x` меняет папку. Поведение bash проверяй через
  `/bin/bash скрипт`.
- merge-guard: любая правка хука — `python3 -I test_merge_guard.py` и `test_merge_guard_shell.py`, плюс прогон
  новых тестов на старой голове (обход должен падать). Иначе тест ничего не доказывает.
- `.claude/**` коммитить с `[skip ci]`. Push в main = деплой прода, вливает только роль 5.
- Совет: один worktree на PR, upstream — своя ветка сразу (`git push -u origin <ветка>`).
