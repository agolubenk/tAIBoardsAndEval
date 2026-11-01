---
paths:
  - apps/backend/**
---

# Database Layer — Prisma + PostgreSQL

## Prisma 7

- **Клиент:** `prisma-client` → `apps/backend/src/generated/prisma` (генерируется `npx prisma generate`, не коммитится).
- **CLI:** `apps/backend/prisma.config.ts` — datasource URL, migrations, seed. Без `--schema` в npm/docker-скриптах.
- **Подключение:** `@prisma/adapter-pg` в `PrismaWriteService` / `PrismaReadService` — не `datasources.db.url` в конструкторе.
- **Импорты:** `@prisma/client` (path alias); runtime-типы — `@prisma/client/runtime/client`.
- **Seed:** `npx prisma db seed` явно; `migrate dev` не запускает seed.

## Read/Write Split — главное правило

Проект имеет `PrismaReadService` и `PrismaWriteService`. **Всегда** используй правильный клиент.

| Операция | Клиент |
|---|---|
| `findMany`, `findUnique`, `findFirst`, `count`, `aggregate` | `PrismaReadService` |
| `create`, `update`, `upsert`, `delete`, `createMany`, `updateMany` | `PrismaWriteService` |
| `$transaction(...)` | `PrismaWriteService` |

❌ Нельзя использовать `PrismaWriteService` для SELECT — это перегружает primary.

## Транзакции

- Всегда `$transaction(callback, { timeout: 10_000, maxWait: 5_000 })`
- Без тяжёлых `findMany` внутри транзакции — риск deadlock
- После записи в Primary, чтение внутри той же транзакции — на `PrismaWriteService`, не на реплику (replication lag)

## N+1 — запрещено

```typescript
// ❌ N+1:
for (const app of applications) {
  await this.dbRead.tenantVacancy.findUnique(...)  // N запросов!
}

// ✅ Batch + Map:
const vacancies = await this.dbRead.tenantVacancy.findMany({
  where: { companyId, vacancyNumber: { in: vacancyNumbers } },
})
const byNumber = new Map(vacancies.map(v => [v.vacancyNumber, v]))
```

## JSON-поля — обязательная Zod-валидация

```typescript
// ❌ ЗАПРЕЩЕНО:
const fields = vacancy.fieldsStateJson as VacancyFieldsState

// ✅ ОБЯЗАТЕЛЬНО:
const fields = VacancyFieldsStateSchema.parse(vacancy.fieldsStateJson ?? {})
// При записи:
data: { fieldsStateJson: fields as Prisma.InputJsonValue }
```

## Пагинация — всегда `take` с ограничением

```typescript
take: Math.min(dto.take ?? 20, 100),  // защита от take=99999
cursor: cursor ? { id: cursor } : undefined,
skip: cursor ? 1 : 0,
orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],  // стабильная сортировка
```

❌ `findMany` без `take` на таблицах с потенциально большим объёмом — запрещён.

## Select — только нужные поля

```typescript
// ❌ SELECT * (тяжёлые JSON, photoUrl):
await this.dbRead.tenantVacancy.findUnique({ where: { id } })

// ✅ Явный select для списков:
await this.dbRead.tenantVacancy.findUnique({
  where: { id },
  select: { id: true, title: true, vacancyNumber: true, status: true },
})
```

## createMany/updateMany вместо циклов

```typescript
// ❌ N INSERT:
for (const row of rows) { await tx.model.create({ data: row }) }

// ✅ 1 запрос:
await tx.model.createMany({ data: rows, skipDuplicates: true })

// ✅ Replace: deleteMany + createMany
await tx.model.deleteMany({ where: { vacancyId } })
await tx.model.createMany({ data: rows.map(r => ({ ...r, vacancyId })) })
```

## Индексы

Любой новый `findMany` с `where` на незаиндексированное поле → добавить `@@index` в `schema.prisma`.
Добавление индекса на prod: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...`

## Одна дев-БД на все ветки — `migrate dev` тут работать не может

> Диагноз 2026-08-16. Симптом «`migrate dev` требует деструктивный reset» повторялся
> и списывался на порчу БД. БД не испорчена — сломан рабочий процесс.

**Механизм.** Дев-контейнер `backend-postgres-1` один, а ветки имеют РАЗНЫЕ наборы
миграций. Замер: в `_prisma_migrations` лежали 8 записей `sourcing_*` с ветки
`feature/sourcing-8-topics` (у неё свой worktree), которых нет в
`prisma/migrations` текущей ветки; одновременно 4 wiki-миграции текущей ветки не
были применены вовсе. `migrate dev` сверяет папку миграций с таблицей — при
расхождении он по построению предлагает единственное, что умеет: reset.

**Что делать (без потери данных):**

| нужно | команда | почему |
|---|---|---|
| применить отставшие миграции своей ветки | `prisma migrate deploy` | применяет pending и не трогает «лишние» записи чужих веток |
| увидеть реальное состояние | `prisma migrate status` | скажет, чего не хватает, без попытки чинить |
| сгенерировать новую миграцию | `prisma migrate diff --from-schema … --to-schema … --script` (Prisma 7: флаги `--from-schema-datamodel`/`--to-schema-datamodel` удалены) | чистый schema-to-schema, к БД не обращается вовсе |

**Чего НЕ делать:** `migrate dev`, `migrate reset`, `db push --force-reset` на общей
дев-БД. Первый упрётся в чужие миграции, остальные два снесут данные.

**Настоящее лечение** — своя БД на ветку (`DATABASE_URL=…/hrhelper_<branch>`) либо
слияние веток. Пока БД общая, чистого `migrate dev` не будет ни при каких правках
её содержимого.

**Проверять перед применением чужого/старого набора миграций:** существуют ли уже
объекты, которые миграция создаёт (`information_schema.tables`/`columns`). Если да —
применять нельзя, только `migrate resolve --applied`; если нет — `deploy` безопасен.

## $transaction — всегда с timeout

```typescript
// ❌ Без timeout — deadlock может зависнуть
await this.db.$transaction(async (tx) => { ... })

// ✅ ОБЯЗАТЕЛЬНО
await this.db.$transaction(
  async (tx) => { ... },
  { timeout: 10_000, maxWait: 5_000 }  // 10s timeout, 5s max wait для получения connection
)
```

**Ограничение Prisma:** правило применимо только к callback-форме (interactive transaction). Batch-форма `$transaction([opA, opB, ...])` выполняется как одна команда на уровне БД — её TS-сигнатура принимает только `{ isolationLevel? }`, добавление `timeout`/`maxWait` даёт `TS2769`. Если аудит находит batch-вызов без `timeout` — это не баг, не пытаться добавить опцию повторно.

## take — максимум 100

```typescript
// ❌ OOM при нагрузке, найдено в аудите
findMany({ take: 5000 })
findMany({ take: 2000 })

// ✅ Максимум 100, для аналитики — cursor streaming
take: Math.min(dto.take ?? 20, 100)

// Для больших выборок в аналитике — streaming батчами
let cursor: string | null = null
do {
  const batch = await this.dbRead.candidateApplication.findMany({
    take: 200,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    orderBy: { id: 'asc' },
  })
  processBatch(batch)
  cursor = batch.at(-1)?.id ?? null
} while (cursor)
```

## async .map() — запрещён без Promise.all

```typescript
// ❌ Выглядит как parallel, работает sequential — N запросов
const results = await rows.map(async (row) => this.dbRead.vacancy.findUnique({ where: { id: row.id } }))

// ✅
const results = await Promise.all(rows.map((row) => this.dbRead.vacancy.findUnique({ where: { id: row.id } })))

// Лучше — batch findMany
const vacancies = await this.dbRead.vacancy.findMany({ where: { id: { in: rows.map(r => r.id) } } })
const byId = new Map(vacancies.map(v => [v.id, v]))
```

## Outbox processor — FOR UPDATE SKIP LOCKED

При N>1 репликах backend, claimBatch() обязан использовать `FOR UPDATE SKIP LOCKED`.
Детали: `.claude/rules/14-realtime.md`
