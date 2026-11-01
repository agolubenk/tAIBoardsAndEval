# База данных и кэш — правила

> Источник: бывший `CLAUDE.md §База данных`. Детали: `.claude/rules/08-database-prisma.md`, `09-cache-redis.md`, `10-db-topology.md` (грузятся по paths при работе с `apps/backend/**`).

**Clients:** `PrismaWriteService` — только write/`$transaction`. `PrismaReadService` — только SELECT. ❌ WriteService для чтения перегружает primary.

## Checklist каждого сервиса с БД

- Все `findMany` имеют `take` с max 100
- JSON-поля через Zod-схему, не `as T`
- Нет N+1 (batch + Map или include)
- Новые WHERE-поля → `@@index` в `schema.prisma`
- После записи → read в той же `$transaction` (атомарность записи+чтения — один физический инстанс, не обход lag)
- `$transaction(callback, { timeout: 10_000, maxWait: 5_000 })` — только callback-форма; batch-форма `$transaction([...])` опций не принимает (TS2769 — не баг)
- `void redis.setex(...)` → `.catch(err => logger.warn(...))`

## Кэширование и очереди

- `CacheService.getOrSet()` для горячих данных; инвалидация ПОСЛЕ транзакции, SCAN вместо KEYS
- Ключи: `{namespace}:{entity}:{id}` c `companyId` для tenant-данных (`company:user:{userId}`, `vac:list:{companyId}:*`, `rbac:{userId}:{companyId}`)
- Операции >200ms или внешние API → BullMQ, не в HTTP-обработчике; DLQ обязателен
- Redis — две роли (с 2026-10-20): кэш `redis` (allkeys-lru, без сохранения) и очереди BullMQ `redis-queue` (noeviction + AOF; compose задаёт `REDIS_QUEUE_HOST=redis-queue`). Backend вне docker без `REDIS_QUEUE_HOST` падает на общий `REDIS_HOST`; `HOST`/`PORT`-пары, не единый `REDIS_URL`

## Топология и prod

- Один инстанс на роль — Postgres/Redis/ClickHouse/MinIO/Kafka одинаковы в dev/test/prod (`infra/docker/docker-compose.yml`); `docker-compose.prod.yml` — только security/expose-оверлей (порты на 127.0.0.1, nginx), отдельных реплик/брокеров нет. См. `.claude/rules/10-db-topology.md`, `infra/docker/README.md`.
- PostgreSQL один инстанс (read и write — тот же процесс); `connection_limit` write 15–25, read 25–40 — никогда не убирать (разделение write/read-клиентов — SRP, не физическая топология)
- `PgBouncer pool_size` × `app_instances` ≤ `max_connections`; `connection_limit` = `pool_size / instances`
- `DATABASE_READ_URL`/`REDIS_READ_HOST`/`CLICKHOUSE_READ_HOST` — опциональные escape-hatch переменные, не заданы по умолчанию нигде (включая prod) → код грациозно падает на primary; `REDIS_QUEUE_HOST` в compose задан (`redis-queue`), вне docker не задан → общий Redis
- Миграции только через CI/CD (не в runtime); индексы на prod — `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
- ClickHouse: один инстанс (8123), без Keeper; `CLICKHOUSE_READ_HOST` опционален — не задан → primary; вставки только через Zod-схему

## Health probes

`GET /api/v1/health` — liveness · `GET /api/v1/health/ready` — readiness (PostgreSQL + Redis, 503 при degraded) · Docker HEALTHCHECK → `/health/ready`
