# Реальное время и стриминг

> Источник: бывший `CLAUDE.md §Реальное время`. Детали и эталонные паттерны: `.claude/rules/14-realtime.md` (грузится по paths).

- **Socket.io:** `@socket.io/redis-adapter` **подключён** (`apps/backend/src/app/hr-helper-io.adapter.ts`, `createAdapter`) — при изменениях не отключать (без него WS не работает при N>1 подах)
- **SSE auth:** всегда ticket (одноразовый, TTL 30s, Redis GETDEL) — не Bearer в URL. Паттерн: `POST /auth/sse-ticket` → `?ticket=`. Обязателен для любого нового SSE-канала (Interview Copilot, Workflow Chat)
- **SSE heartbeat:** `setInterval` каждые 25s с `data: keep-alive\n\n` — иначе соединение рвётся через 30–60s
- **SSE масштабирование:** Redis pub/sub на канал `sse:company:{companyId}` — при N>1 подах
- **Outbox** при N>1 подах: `SELECT ... FOR UPDATE SKIP LOCKED` (иначе double-processing)
