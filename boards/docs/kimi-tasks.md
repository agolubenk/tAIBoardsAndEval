# t-boards — задачи для Kimi (волна 1)

Составлено: 2026-10-27 08:10. Спека — `boards/docs/t-boards-spec.md` (v0.3): ID правил (R-…), запретов (N-…) и приёмки
(AC-…) ниже ссылаются на неё. Архитектура — `boards/docs/architecture-overview2.0.md`; где она расходится со спекой,
действует спека (см. блоки «Пометка (спека t-boards v0.3…)»).

## Состояние форка

- `boards` — клон kaneo v2.46.2 (git remote `upstream` = usekaneo/kaneo, локальная ветка `t-boards`).
  Своих коммитов пока нет.
- Стек: pnpm 10.32.1 + vite-plus (`vp`), Hono + Drizzle + better-auth (`apps/api`), Vite + i18next (`apps/web`),
  пакеты в `packages/*`, тесты — vitest.
- На этом Mac node v25.9.0, а kaneo требует `^24.11.0 || >=26`. pnpm 10.32.1 стоит глобально (с 27.10 08:10).
  Установка: `pnpm install --config.engine-strict=false` (93 с, только WARN про engine). Проверено 27.10:
  - тесты пакета: `pnpm --filter @kaneo/importers test` → 36 файлов, 373 теста, pass;
  - тесты по пути: `pnpm --filter @kaneo/web exec vp test run src/lib/i18n` → 8/8, pass;
  - `npx vitest` из папки пакета **нельзя**: он берёт vitest из `node_modules` HR Helper этажом выше;
  - хуки husky: pre-commit — `pnpm lint` (`vp check`, ~1,5 с на весь репозиторий); commit-msg — commitlint
    `config-conventional`. Сообщения коммитов — `feat(redact): …`, `fix(i18n): …` и т. п.;
  - новый пакет в `packages/*` подхватывается workspace автоматически. После его создания — `pnpm install` в
    worktree.

## Общие правила (для всех задач)

1. **Отдельный worktree, не общая папка.** Параллельно в `boards` работает Claude. Ворктри волны 1
   (`app-kimi`, `app-kimi2`) удалены 29.10 — создай свежий:
   `git -C /Users/agolubenko/Desktop/Development/HR_Helper-v2/t-boards/app worktree add ../app-kimi -b kimi/k6-metrics`.
   - В новом worktree — свой `pnpm install --config.engine-strict=false`: `node_modules` у worktree свои.
   - На каждую задачу — своя ветка `kimi/k<n>-<тема>` от `t-boards`.
   - Коммитить локально; в отчёте указать SHA.
2. **`git push` запрещён.** Единственный remote — апстрим kaneo, чужой репозиторий.
3. **Только TypeScript поверх kaneo.**
   - Python control plane из §16 архитектуры не реализовывать: вопрос стека Q-107 открыт, решение — ядро kaneo на TS.
   - SSE не добавлять.
4. **Чужие зоны не трогать** — их сейчас правит Claude:
   - `apps/api/src/mcp/**`, `packages/mcp/**`;
   - `apps/api/src/database/**` (схема, миграции);
   - `apps/api/src/auth.ts`;
   - `compose*.yml`, `.env*`.
   Нужна правка там — написать в отчёте, что и зачем.
5. **Данные:**
   - без ПДн (N-002);
   - фикстуры только синтетические;
   - в Notion и claude-mem — ни одного вызова на запись (N-001, R-040).
6. **Гейт задачи** — тесты и типы своего пакета зелёные плюс прогон соседних тестов, если правились общие типы.
7. **Отчёт** — `boards/docs/kimi-reports/K-<n>.md`:
   - ветка и SHA;
   - изменённые файлы и зачем;
   - точные команды и их результат (pass/fail, числа);
   - что не проверено, риски.

## K-1. Русский интерфейс по умолчанию (R-093, часть AC-018)

**Зачем.** RU-локаль в kaneo есть: `i18n/ru-RU.json`, все 2915 ключей EN на месте. Но 947 значений совпадают с
английскими, и из них 518 — фразы от трёх слов. Основная масса — в `settings` (327), дальше `auth` 26, `workspace`
17, `common` 16, `tasks` 11, `team` 10.

**Сделать:**
1. Перевести в `i18n/ru-RU.json` все непереведённые строки, кроме разделов `landing` и `press`: у t-boards нет
   лендинга.
   - Бренды и термины оставить как есть: Kaneo, GitHub, API, URL, Markdown, MCP.
   - Плейсхолдеры `{{…}}` сохранить побуквенно.
   - Множественное число RU: `_one/_few/_many/_other`. Пример ошибки: в `sent_few` и `sent_many` сейчас английский.
2. `i18n/resources.ts`: поставить `defaultLocale = "ru-RU"`. Тесты локали, которые ждут `en-US`, поправить.
3. Бренд Kaneo → t-boards не переименовывать: это отдельное решение.

**Готово, когда:**
- скрипт сверки ключей печатает `untranslatedSame`. Вне `landing`/`press` остались только бренды и термины, их
  список приложен к отчёту. Скрипт:
  ```
  node -e 'const f=(o,p="")=>Object.entries(o).flatMap(([k,v])=>typeof v==="object"&&v?f(v,p+k+"."):[[p+k,v]]);const en=new Map(f(require("./i18n/en-US.json"))),ru=new Map(f(require("./i18n/ru-RU.json")));const s=[...en].filter(([k,v])=>ru.get(k)===v&&/[a-z]{3}/i.test(v)&&!/^(landing|press)\./.test(k));console.log(s.length);s.forEach(([k,v])=>console.log(k,"=>",v))'
  ```
- тесты `apps/web` про i18n зелёные;
- JSON проходит `i18n/schema.json`, если kaneo её проверяет.

## K-2. Пакет вычистки секретов `packages/redact` (R-036, N-009, AC-023)

**Зачем.** Транскрипты, сводки и семена проходят чистку до того, как их можно прочитать.

**Интерфейс (Claude будет вызывать именно его):**
```ts
export type SecretKind =
  | "api_key" | "jwt" | "pem" | "db_url" | "bearer" | "base64_blob" | "password_assignment";
export type RedactHit = { kind: SecretKind; start: number; end: number };
export function redact(text: string): { text: string; hits: RedactHit[] };
// на месте секрета — метка [REDACTED:<kind>]; функция чистая, без I/O
```

**Сделать:**
- Распознавать:
  - префиксы ключей: `sk-`, `sk-ant-`, `ghp_`, `gho_`, `github_pat_`, `xox[abp]-`, `AKIA…`, `glpat-`, `AIza…`;
  - JWT (три base64url-сегмента);
  - блоки PEM `-----BEGIN … KEY-----`;
  - строки подключения вида `postgres://user:pass@`, `redis://:pass@`, `mongodb+srv://`;
  - `Authorization: Bearer …`;
  - присваивания `password=` / `"password": "…"` / `SECRET=`;
  - длинные base64-блобы с высокой энтропией (порог — константа, обосновать в отчёте).
- **Корпус тестовых секретов собирать в рантайме теста** (конкатенацией частей), а не хранить литералами: иначе в
  репозитории появятся строки, похожие на секреты, и на них сработают сканеры.
- Один нестандартный формат (например, ключ без префикса в YAML) намеренно не ловится. Тест фиксирует это как
  известный пропуск (AC-023).
- Ложные срабатывания: git SHA, UUID и хэши sha256 в обычном тексте не трогать — отдельный тест.
- Бенчмарк: пропускная способность в МБ/с и p95 задержки на кусок 1 МБ. Числа — в отчёт.

**Готово, когда:** тесты пакета зелёные, известный пропуск зафиксирован тестом, числа бенчмарка в отчёте.

## K-3. Пакет формата ответа MCP `packages/agent-format` (R-032, R-033, AC-012, AC-022)

**Зачем.** Ответ MCP оборачивается в TOON, тексты внутри — строки Markdown; бюджет ответа — 150–2500 входящих
токенов, и считает их один счётчик на стороне t-boards.

**Интерфейс (Claude подключит его в `apps/api/src/mcp`):**
```ts
export type WireFormat = "toon" | "json";
export function encodeResponse(value: unknown, opts?: { format?: WireFormat }):
  { text: string; format: WireFormat; fallbackError?: string };   // ошибка кодека TOON → JSON + причина
export function decodeResponse(text: string, format: WireFormat): unknown;
export interface TokenCounter { name: string; count(text: string): number }
export const defaultCounter: TokenCounter;                         // o200k_base — см. ниже
export function fitToBudget(value: unknown, opts: {
  budget?: number;            // по умолчанию и потолок — 2500 (минимум 150)
  format?: WireFormat;
  fullRef: string;            // ссылка на полный текст, вставляется при усечении
  counter?: TokenCounter;
}): { text: string; format: WireFormat; tokens: number; truncated: boolean };
```

**Сделать:**
- TOON — через эталонную библиотеку `@toon-format/toon` 4.4.0 (MIT, версия опубликована раньше 2026-10-13).
  Собственный кодек не писать, только обёртку.
- Счётчик — `gpt-tokenizer` (MIT), кодировка o200k_base. Это пока предложение D-018, поэтому он стоит за
  интерфейсом `TokenCounter`, чтобы его можно было заменить одной строкой.
- Усечение структурное: сначала укорачивать длинные строки Markdown, затем хвосты массивов. Ответ всегда остаётся
  валидным TOON/JSON и содержит `fullRef` и признак `truncated`. Разрезать сериализованный текст посередине нельзя.
- Тесты AC-022 (round-trip TOON → объект совпадает с исходником):
  - Unicode, включая кириллицу и эмодзи;
  - пустые строки, `null` и отсутствующие ключи — различаются после round-trip;
  - вложенность ≥ 4 уровней;
  - массивы однородных объектов (табличная форма TOON) и разнородных;
  - Markdown с таблицами, кодом, переносами строк и `|`, `:`, `,` внутри значений.
- Замер на 3 синтетических «карточках», похожих на реальные: токены JSON против TOON. Числа — в отчёт; это заготовка
  под AC-001.

**Готово, когда:** тесты зелёные, есть тест «ошибка кодека → JSON + `fallbackError`», таблица замера в отчёте.

## K-4. Импорт из Notion в `packages/importers/src/notion` (R-080, AC-002, AC-026)

**Зачем.** До перехода t-boards — зеркало Notion только для чтения. Импорт идемпотентный и продолжается после
обрыва.

**Сделать по образцу `packages/importers/src/linear`** (client / mapping / source / тесты):
- `connectNotion({ token, databaseIds })` → `ImportSource`.
  - Клиент работает через инжектируемый `FetchLike` с REST API Notion (`/v1/databases/{id}/query`,
    `/v1/blocks/{id}/children`).
  - Пагинация через `start_cursor`, размер страницы ≤ 100.
- Маппинг полей карточки (R-024): Status → колонка; Priority / Severity → `ImportedPriority`, исходное значение
  сохранить; Backlog ID, Half-baked idea, Report, связи (relation) → `ImportedRelation`.
- `types.ts`: добавить **необязательные** поля, не ломая остальные импортёры:
  - `sourceRef?: { system: "notion"; pageId: string; lastEditedTime: string }`;
  - `extraFields?: Record<string, string | number | boolean | null>`;
  - `terminalReason?: string`.
- Ключ идемпотентности задачи — `${product}:notion:${pageId}`. Хелпер и тест: повторный импорт той же страницы даёт
  тот же ключ.
- Страница `archived` / `in_trash` → `archived: true` и `terminalReason`, не пропуск.
- Тело страницы → Markdown через уже имеющийся `markdown.ts` / turndown, без своего конвертера.
- `reconcile(sourcePages, imported)` → счётчики по типу и статусу и поимённый список расхождений (AC-002).
- Тесты — только на синтетических фикстурах ответов Notion API. **Реальный Notion не вызывать**, токен не нужен.
- Запись в БД (upsert по `last_edited_time`, история) — не в этой задаче: её делает Claude вместе со схемой.

**Готово, когда:**
- тесты `@kaneo/importers` зелёные целиком, а не только notion;
- `notion` добавлен в `IMPORT_SOURCE_IDS`;
- у `mapping` и `reconcile` есть отдельные тесты.

## Волна 2 — после того как Claude поднимет форк локально (отметка появится здесь)

**Открыта 2026-10-27 14:07.** Форк поднят и работает:
- web — http://localhost:5173, API — http://localhost:1337, вход `admin` / `admin`;
- Postgres — `compose.t-boards.yml` на 127.0.0.1:5433.

Своё поднимать для K-6 не нужно: замер идёт по этому стенду.

Код Claude (модель леса и всё остальное) закоммичен в `boards`, ветка `t-boards` (головы `63bc00d`…`8bf6ee4`).
K-4 и K-5 переданы Claude и закрыты; частичные наброски Kimi по ним — `archive/kimi-partial-k4-k5/`.
Волна 2 (K-6, K-7): ворктри создать заново по правилу 1. Детали — `impl-progress.md`.

- **K-5. Читатель claude-mem** (R-040, R-042, AC-014).
  - Клиент только на GET к HTTP API воркера: `/api/health`, `/api/projects`, `/api/observations`,
    `/api/observation/:id`. Порт — из `CLAUDE_MEM_WORKER_PORT` / settings.
  - Привязка наблюдения к карточке по ветке и ID задачи.
  - Воркер недоступен (Mac спит) → последняя копия с отметкой времени, без падения.
  - Файл `~/.claude-mem/claude-mem.db` напрямую не открывать.
- **K-6. Замеры AC-018 и AC-016:**
  - экран 400 px, профиль 3G;
  - JS критического пути — в байтах через `node zlib -9`;
  - RSS ядра в простое и под нагрузкой.
  Только замер и отчёт, без оптимизаций.
- **K-7. Контейнер open-notebook с лимитом памяти** — после ответа владельца на Q-105 (где считаются эмбеддинги).

## Не для Kimi сейчас

- Делает Claude:
  - MCP-слой (`apps/api/src/mcp`, `packages/mcp`);
  - модель леса — деревья, секторы, вырубка, брёвна, семена (R-028, R-029);
  - lease и fencing (R-026);
  - права агента и «да» владельца (R-022, N-011);
  - схема и миграции;
  - локальный запуск, вход admin/admin.
- Этап 2 (после перехода):
  - abide и ревью-пайплайн (R-070–R-074);
  - библиотека скиллов (R-060);
  - конструктор форм (R-027);
  - облачные сессии (R-035).
