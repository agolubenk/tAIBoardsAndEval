# CI/CD, сборка, инфраструктура

> Источник: бывший `CLAUDE.md §CI/CD` + §Инфраструктура. Канон скриптов: `infra/scripts/README.md`.

## OOM при vite build

Сборка фронтенда держит ~3.9 GB живого heap (замер `--trace-gc` 2026-09-29) — heap 6 GB.
Значение задают сами npm-скрипты `build`/`build:bundle` (`apps/frontend/package.json`) — внешний
`NODE_OPTIONS` (env CI-шага, `ENV` в `Dockerfile.frontend.prod`) ими перетирается, держать в синхроне
только ради читаемости. При 4 GB prod-образ падал OOM на шаге «computing gzip size», и каждый деплой
после `0733562` (2026-09-27) обрывался до `up` — старый стек жил, новый код не выкатывался.
`build.reportCompressedSize: false` в `vite.config.ts` снимает этот пик; бюджет бандла считает gzip сам.

> Backend после stabilization 2026-07-04 — heap 6144 (см. memory `project_stabilization`).

## Инфраструктура

- **Один инстанс на роль — dev/test/prod одинаково.** Postgres/Redis/ClickHouse/MinIO/Kafka — единственный сервис на роль во всех окружениях (`infra/docker/docker-compose.yml`); `docker-compose.prod.yml` — только security/expose-оверлей (порты на `127.0.0.1`, nginx), реплик и прод-специфичной топологии в нём больше нет. Kafka — один брокер, `profiles: [kafka-lean]`, опционален (`--profile kafka-lean`); дефолтный transport — `QUEUE_TRANSPORT=bullmq`, backend не имеет hard `depends_on` на Kafka. Подробности и обоснование — канон `.claude/rules/10-db-topology.md`.
- Очереди BullMQ — отдельный сервис `redis-queue` (noeviction + AOF, с 2026-10-20; compose задаёт `REDIS_QUEUE_HOST=redis-queue`), кэш — `redis` (allkeys-lru). Перенос незавершённых задач между ними — `infra/scripts/prod/bullmq-move-jobs.mjs`
- Секреты docker-compose — `${VAR:-default-for-dev}`, не хардкод для prod
- `*.latest` образы → зафиксировать версии (MinIO: `RELEASE.2025-09-07T16-13-09Z`)
- `PgBouncer pool_size` × `app_instances` ≤ `max_connections` Postgres
- Стейл-образ telegram-sessions ↔ backend = UNIMPLEMENTED / тихие деградации — при «мистике» сначала `docker compose build telegram-sessions`
- Docker HEALTHCHECK → `/api/v1/health/ready`

## Frontend — Excel I/O

- Импорт/экспорт таблиц: `exceljs` только через `apps/frontend/src/shared/excel/excelWorkbook.ts` (динамический импорт)
- Поддерживается только `.xlsx` (legacy `.xls` не читается); в UI `accept=".xlsx"`

## Гейты качества

- Frontend typecheck: `npx tsc --noEmit` из `apps/frontend` — **молчаливый no-op**; настоящий гейт — `tsc -b` / `npm run build` (см. memory)
