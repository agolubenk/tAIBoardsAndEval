# Telegram — MTProto / Session Manager

> Источник: бывший `CLAUDE.md §Telegram-интеграция`. Детали: `.claude/rules/16-telegram.md` (грузится по paths) · диагностика 2026-07-08: `АНАЛИЗ_И_ПЛАН_ОПТИМИЗАЦИИ.md` (git-история).

**Один Telegram auth key — один живой владелец.** Владельцы: Session Manager (`apps/telegram-sessions`, gRPC, canary-маршрутизация `TELEGRAM_SESSION_CANARY_PERCENT`) и legacy GramJS-пул backend (`telegram-mtproto-pool.service.ts`). Второй одновременный коннект тем же auth key = `406 AUTH_KEY_DUPLICATED` + reconnect-шторм.

## Правила

- Новые Telegram-операции — **только** через SM RPC (`packages/proto/hr_helper/v1/telegram-sessions.proto`); whitelist `B8_LEGACY_GRAMJS_OPERATIONS` (`telegram-session-guard.util.ts`) только сокращать (сейчас только `sendMessageDirect`), никогда не расширять
- Ownership-lock `tg:owner:{userId}` (Redis): оба пула берут лок перед `connect()` — SM `SessionOwnershipService`, backend `acquireSessionOwnership`; version handshake `BUILD_SHA` при первом gRPC-клиенте к поду
- `406 AUTH_KEY_DUPLICATED` ≠ «сессия недействительна»: auth key валиден, это конфликт владения — drop+retry в пуле, НЕ заставлять пользователя переподключать Telegram
- **Каждый путь отправки обязан пробрасывать `parse_mode`**: text, quote-reply, edit, caption файлов, notifications, автоматизации. Потеря = получатель видит сырые HTML-теги. Шаблон с разметкой в композер — только как HTML-фрагмент через DOMPurify(tgAllowlist), не plain text
- Peer-резолвинг: свежий SM-клиент имеет пустой entity cache (`StringSession` не персистит entities) — `getEntity(числовой id)` без прогрева `getDialogs` упадёт («Пир не найден»); fallback: прогрев + access_hash hint из БД
- Стейл-образ SM ↔ backend = UNIMPLEMENTED / тихие деградации — при «мистике» сначала `docker compose build telegram-sessions`

## Статус миграции (см. memory `project_telegram_sm_b9`)

B9 завершён 2026-06-20: whitelist 31→6→1; остаток `sendMessageDirect` требует MinIO в SM (LEGACY-1 Phase 2). Технический долг: вывод legacy GramJS-пула.
