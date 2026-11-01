---
paths:
  - apps/**
  - packages/**
---

# Антипаттерны — индекс

Правило с примером ❌/✅ грузится само, когда открыт файл из его `paths:`. Здесь — где оно лежит. Исключение:
`03-frontend` грузится только в `apps/frontend/**`, в `apps/extension` (тоже React) его открыть вручную. Почему паттерн
запрещён, что ломается и срез зависимостей — `docs/engineering/antipatterns.md` (статья блокнота t-boards).

| Тема | Правило |
|---|---|
| Типизация входа: `body: unknown`, DTO, `as unknown as T`, ClickHouse — Zod до вставки | `04-type-safety`, `05-security` |
| Регистрация агентов: `registerQueueAgent()` | `13-agents-mcp` |
| Mutable singleton → `onModuleInit` · HTTP только через `HttpClientService` | `02-backend` |
| Приём файлов `@UploadPolicy` · MCP-ключ не из query · HMAC через `timingSafeEqual` · npm audit | `05-security` |
| БД: `$transaction` с `{timeout, maxWait}`, `take` ≤ 100, batch вместо N+1, outbox `SKIP LOCKED` | `08-database-prisma` |
| `void redis.*` без `.catch` | `09-cache-redis` |
| Real-time: Redis-адаптер Socket.io, heartbeat SSE 25 с | `14-realtime` |
| Telegram: SM RPC, `parse_mode` на всех путях, 406 — конфликт владения, прогрев `getEntity`, вставка шаблона | `16-telegram` |
| Frontend: DOMPurify, мемоизация `Provider`, тяжёлые импорты, FSD, query keys, eslint/tsconfig, `${var}` в `defaultValue` | `03-frontend` |
| `process.env` вне `config/` · размер файлов и методов · баг → t-boards «Ошибки» | корневой `CLAUDE.md`, `01-base` |
