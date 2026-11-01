# Базовые правила (всегда)

> **Sync:** также `CLAUDE.md`

## Куда класть файл

- Код приложения → `apps/<app>/src/`
- Shared без Nest/React → `packages/`
- Фикстуры/mock → `examples/` или `__mocks__/` — **не** в `features/`
- Инфраструктура → `infra/`
- Артефакты → `artifacts/`

## DRY — STOP & CHECK

1. Grep — нет ли похожей функции/типа?
2. DTO в 2+ местах → `packages/types`
3. Утилита в 2+ местах → `packages/utils`
4. Не копировать логику backend ↔ frontend — контракт через `packages/`

## SOLID

- **S** — сервис >300 строк или метод >80 → декомпозиция
- **O** — новый провайдер/адаптер = новый класс
- **L** — AI/Storage/Notifications через интерфейс
- **D** — `ConfigService`, не `process.env` в сервисах

## Запреты

- Доменная логика в `common/` (только инфраструктура Nest)
- Mock в `features/`
- Дубли типов из `packages/types`
- Метод >100 строк без декомпозиции
- `*.zip`, `db_dump.sql`, `*.env` в git

## Документация — куда смотреть и куда писать

`docs/` разложена по ролям — карта и «куда что класть»: `docs/README.md`, стандарт документа — `docs/CLAUDE.md`;
роли по коду — ближайший `CLAUDE.md` (сводка — корневой `CLAUDE.md`). Канон открытого бэклога/багов — t-boards
(«Задачи»/«Ошибки», хард-стопы — `.claude/rules/17-notion-board.md`; Notion — архив только для чтения); закрытого — `docs/plans/done/<модуль>.md` (оглавление `docs/plans/DONE.md`); `docs/plans/BACKLOG.md`
и `docs/plans/archive/` — снимки 2026-08-12, новое туда не пишем и для скоупа открытой работы не читаем.

**Закрытие пункта** — компактная запись в `docs/plans/done/<модуль>.md` (дата · что сделано · ссылка на коммит/раздел · ключ карточки t-boards) и статус карточки; замороженные снимки при закрытии не редактируются.

**t-boards — канон открытого** (контент, статус, обсуждение) — хард-стопы `.claude/rules/17-notion-board.md`: сырые идеи (`halfBaked`) не берутся в работу; «Ошибки» приоритетнее «Задач»; закрытие пункта — статус карточки И запись в `docs/plans/done/<модуль>.md` вместе.

## Anti-patterns (ссылки на полный список)

Правила с примерами — по месту работы (`.claude/rules/02–16`, грузятся по `paths:`), индекс тем —
`.claude/rules/00-antipatterns.md`, причины и срез зависимостей — `docs/engineering/antipatterns.md`.

Краткие дополнения к базовым правилам:

### Размер файлов — жёсткий лимит
- Сервис/хук/компонент **>500 строк** → обязательная декомпозиция (PR не принимается)
- Метод **>100 строк** → вынести в sub-method или helper

### body: unknown в контроллерах
❌ `@Body() body: unknown` — в любом контроллере backend
✅ Всегда typed DTO: `@Body() dto: CreateVacancyDto`

### async .map() без Promise.all
❌ `const results = await items.map(async item => processItem(item))` — это sequential N запросов
✅ `const results = await Promise.all(items.map(item => processItem(item)))`
Или лучше: batch `findMany({ where: { id: { in: ids } } })` + Map

### Документация при находке
Нашёл баг/уязвимость/несостыковку — сразу карточкой t-boards в «Ошибки» (канон открытого, `.claude/rules/17-notion-board.md`). Не откладывать.
