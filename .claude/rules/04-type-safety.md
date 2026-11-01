---
paths:
  - apps/backend/**
  - apps/frontend/**
  - packages/**
---

# TypeScript type safety

## Запреты

- `body: unknown` в контроллерах
- `as unknown as T` без Zod
- `Record<string, unknown>` для payload форм
- `(x as any).field` — type guard или Zod
- `process.env` вне `config/*.ts`

## Паттерны

- Shared DTO → `packages/types`, оба приложения импортируют
- `Prisma.JsonValue` при чтении → `Schema.parse()`, не cast
- `tsconfig`: `strict`, `noUncheckedIndexedAccess`
- Config: `registerAs` + `ConfigService.get('app.key')`

## ClickHouse — Zod обязательна

```typescript
// ❌ ЗАПРЕЩЕНО — нетипизированные вставки
async insert(table: string, rows: Record<string, unknown>[]) {}

// ✅ Схема для каждой таблицы
const CandidateFactSchema = z.object({
  company_id: z.string().uuid(),
  application_id: z.string().uuid(),
  stage_id: z.string().nullable(),
  updated_at: z.string().datetime(),
})
type CandidateFact = z.infer<typeof CandidateFactSchema>

async insertCandidateApplicationFacts(rows: CandidateFact[]): Promise<void> {
  rows.forEach(r => CandidateFactSchema.parse(r))  // fail fast при несоответствии
  await this.clickhouse.insert('candidate_application_facts', rows)
}
```

## as unknown as Prisma.InputJsonValue — только после Zod.parse

```typescript
// ❌ ЗАПРЕЩЕНО — нет проверки структуры
data: { fieldsConfig: dto.fieldsConfig as unknown as Prisma.InputJsonValue }

// ✅ Zod перед сохранением
const validated = OfferFieldsConfigSchema.parse(dto.fieldsConfig)
data: { fieldsConfig: validated as Prisma.InputJsonValue }
```

## timingSafeEqual для сравнения секретов/подписей

```typescript
// ❌ Timing attack при строковом сравнении
if (receivedSignature === computedSignature) { ... }

// ✅
import { timingSafeEqual } from 'crypto'
const a = Buffer.from(receivedSignature)
const b = Buffer.from(computedSignature)
if (a.length !== b.length || !timingSafeEqual(a, b)) {
  throw new ForbiddenException('Invalid signature')
}
```

Применять везде: webhook signature verification, API key comparison, TOTP verification.
