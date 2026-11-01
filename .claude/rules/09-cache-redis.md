---
paths:
  - apps/backend/**
---

# Cache & Queue — Redis + BullMQ

## Что кэшировать

> **Аудит PERF-CACHE-1 (2026-07-27):** все 5 горячих пунктов покрыты; фактические ключи в коде отличаются от канонических имён ниже — при работе использовать фактические, не заводить дублей под каноническими.

| Данные | TTL | Канонический ключ | Фактический ключ в коде |
|---|---|---|---|
| `resolveCompanyId(userId)` | 60 сек | `company:user:{userId}` | `company:user:{userId}` (`tenant-user-company-id.service.ts`) |
| Список вакансий (сводка) | 30 сек | `vac:list:{companyId}:{userId}` | `vacancy:list:{companyId}` (`vacancies.service.ts`, скип при `usePrimary`) |
| Настройки компании | 120 сек | `co:settings:{companyId}` | `hr-ops:settings:{companyId}` (`hr-ops-access.service.ts` + `hr-ops-settings.util.ts`, инвалидация в `HrOpsSettingsService.patch`) |
| RBAC роли | 60 сек | `rbac:{userId}:{companyId}` | `auth:tenant-user:{userId}` (`jwt-user-cache.service.ts`, L1 LRU + Redis) — per-request hot path это JWT-валидация; отдельного per-request резолвинга RBAC-матрицы в коде нет |
| Счётчики pipeline / KPI | 15 сек | `kpi:{companyId}:{pipelineId}` | `getOrSet` в `recruiting-analytics.controller.ts` (`ANALYTICS_CACHE_TTL_SEC`) |

## Инвалидация — обязательно после мутации

```typescript
// После изменения вакансии:
await this.cache.invalidate(`vac:list:${companyId}:*`)
await this.redis.del(`vac:detail:${companyId}:${vacancyNumber}`)
// НИКОГДА не инвалидировать ДО транзакции
```

## void redis — запрещено глотать ошибки

```typescript
// ❌ ЗАПРЕЩЕНО:
void this.redis.setex(key, ttl, value)

// ✅ ОБЯЗАТЕЛЬНО:
this.redis.setex(key, ttl, value)
  .catch(err => this.logger.warn(`Redis setex failed for ${key}: ${err.message}`))
```

## BullMQ — тяжёлые операции в очередь

Всё что дольше 200ms или вызывает внешние API → в очередь, не в HTTP-обработчик:

```typescript
await this.queue.add('parse', { resumeId, fileKey }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
})
```

## Distributed Lock — для операций без идемпотентности

```typescript
const lock = await this.redis.set(lockKey, '1', 'EX', 30, 'NX')
if (!lock) throw new ConflictException('Already in progress')
try { await doWork() } finally { await this.redis.del(lockKey) }
```

## Соглашение по ключам

Формат: `{namespace}:{entity}:{id}[:{subkey}]`

```
company:user:{userId}       # companyId по userId
vac:list:{companyId}:...    # список вакансий
vac:detail:{companyId}:{n}  # детали вакансии
co:settings:{companyId}     # настройки компании
rbac:{userId}:{companyId}   # роли пользователя
kpi:{companyId}:{pipeline}  # счётчики
lock:{resource}:{id}        # distributed lock
```

❌ Короткие нечитаемые ключи (`c1`, `v_123`) — запрещены.
❌ Tenant-данные без `companyId` — запрещены (утечка между тенантами).

## SCAN вместо KEYS при инвалидации

```typescript
// ❌ KEYS блокирует Redis:
const keys = await this.redis.keys('vac:list:*')

// ✅ SCAN не блокирует:
const stream = this.redis.scanStream({ match: 'vac:list:*', count: 100 })
```

## BullMQ — Dead Letter Queue

```typescript
// ✅ Добавить DLQ для всех очередей
const worker = new Worker(queueName, processor, options)
worker.on('failed', async (job, err) => {
  if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
    await dlqQueue.add('dead', {
      originalQueue: queueName,
      jobData: job.data,
      error: err.message,
      failedAt: new Date().toISOString(),
    }, { removeOnComplete: false })
    this.logger.error(`Job ${job.id} sent to DLQ: ${err.message}`)
  }
})
```

## Redis pub/sub для SSE горизонтального масштабирования

```typescript
// При публикации события (любой под)
await this.redis.publish(`sse:company:${companyId}`, JSON.stringify(event))

// При открытии SSE — subscribe на канал компании
const sub = this.redis.duplicate()
await sub.subscribe(`sse:company:${companyId}`)
sub.on('message', (_, msg) => res.write(`data: ${msg}\n\n`))
req.on('close', () => { sub.unsubscribe(); sub.disconnect() })
```

## Rate limiting для внешних API

```typescript
// Huntflow: 400 imports/company/day — обязательный counter
const today = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
const key = `hf:import:${companyId}:${today}`
const count = await this.redis.incr(key)
await this.redis.expireat(key, endOfDayTimestamp())
if (count > 400) throw new TooManyRequestsException('Daily Huntflow limit reached')
```
