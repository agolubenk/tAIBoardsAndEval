# Безопасность — абсолютные правила

> Источник: бывший `CLAUDE.md §Безопасность`. Детали: `.claude/rules/05-security.md` (грузится по paths при работе с `apps/backend/**`).

- ❌ НИКОГДА не возвращать `refresh_token` в JSON-теле ответа — только httpOnly cookie (исключение: native mobile — refresh в JSON-теле, см. `domain-mobile`)
- ❌ Не использовать JWT из URL-параметров для постоянных access tokens; для SSE — `POST /auth/sse-ticket` → `?ticket=` (одноразовый, TTL 30 с, Redis GETDEL). Тот же паттерн обязателен для **любого** нового SSE-канала — не изобретать новый auth для SSE
- ❌ Swagger UI НЕ включать в production — условие `NODE_ENV !== 'production'`
- Extension SSE: `POST /extension/ats/sse-ticket` (Bearer extension token) → `?ticket=` на `/extension/ats/watch`
- **MCP / Plugin API ключи и секреты** (`McpApiKey`, `PluginOAuthClient`) → хранить только хэш (`sha256`/`bcrypt`), plaintext-ключ показывать пользователю один раз при создании и никогда повторно (детальный дизайн: `docs/plans/roadmap/phase-e.md §2`)
- **Webhook-доставка** (`WebhookDeliveryProcessor`) → каждый payload подписывать HMAC (`X-HrHelper-Signature`), сравнение — только `timingSafeEqual`, не `===` (см. `docs/plans/roadmap/phase-e.md §3.2`)
- **HITL/Rules actions с approval** (`requiresApproval`/`requiresHITL`) → MCP и Extension delivery каналы НЕ получают bypass: единый `AutomationRunLog` со статусом `PENDING_APPROVAL`
- OAuth secrets (hh/Huntflow) encrypted; platform secret не возвращать в GET; секреты не в логах и не в JSON ответах
- В dev `secure: false` для refresh cookie (HTTP localhost) — осознанный trade-off; на staging/prod без TLS не запускать
- Все `*.latest` docker-образы → зафиксировать версии (MinIO: `RELEASE.2025-09-07T16-13-09Z`, не 2024 — иначе xl header v3 на существующем volume)
- Секреты docker-compose — через `${VAR:-default-for-dev}`, не хардкод в git для prod
