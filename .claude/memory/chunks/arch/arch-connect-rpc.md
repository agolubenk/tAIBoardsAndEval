# Connect RPC — транспортный слой (gRPC-web)

> Источник: бывший `CLAUDE.md §Транспортный слой` (перенесено в DAMS 2026-07-12). Покрытие сверять по `connect.module.ts`.

**Статус (сверено с кодом 2026-07-12):** внедрён широко — **38 роутеров** в `apps/backend/src/connect/` (candidates, vacancies, telegram + telegram-sessions, workflow, wiki, interviews, calendar, hr-ops, search, accounts, …). Telegram-сообщения (send/edit с `parse_mode`) — уже в Connect (`telegram.proto`).

Переключение: `VITE_API_TRANSPORT=connect` (`apps/frontend/src/shared/api/connectTransport.ts`) — **по умолчанию REST**: флаг не задан ни в infra, ни в CI.

## Паттерн миграции модуля

1. Добавить rpc в `packages/proto/hr_helper/v1/<module>.proto`
2. `npm run proto:generate` → типы в `packages/rpc/src/gen/`
3. Реализовать `<Module>ConnectRouter` в `apps/backend/src/connect/`
4. Зарегистрировать в `connect.module.ts`
5. Добавить `<module>Connect.ts` в `apps/frontend/src/shared/api/`
6. В существующем `<module>.ts` добавить ветку `if (isConnectTransportEnabled())`

## Приоритет

Не «мигрировать модули» (основное покрыто), а включить `connect`-транспорт на staging, замерить p95/payload и включить на prod (BACKLOG: ARCH-CON-1).

## Правила

- **Новые read-heavy эндпоинты — сразу в Connect, не в REST** (REST только для совместимости или по явному согласованию)
- JSON-в-protobuf допустим для сложных DTO при инкрементальной миграции
- Один `.proto` на модуль, `service` = бизнес-домен
