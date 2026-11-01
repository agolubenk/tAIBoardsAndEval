---
paths:
  - apps/telegram-sessions/**
  - apps/backend/src/modules/integrations/telegram/**
  - apps/backend/src/modules/notifications/**
  - apps/backend/src/modules/hitl/hitl-telegram*.ts
  - apps/backend/src/connect/telegram*.ts
  - apps/frontend/src/features/telegram/**
  - apps/frontend/src/shared/api/telegram/**
  - apps/frontend/src/pages/authorized/integrations/telegram/**
  - packages/proto/hr_helper/v1/telegram*.proto
---

# Telegram — MTProto, Session Manager, отправка сообщений

> Диагностика-первоисточник: `АНАЛИЗ_И_ПЛАН_ОПТИМИЗАЦИИ.md` (git-история) (2026-07-08), задачи: BACKLOG §Telegram.

## Архитектура владения сессией

```
Один пользователь = один Telegram auth key (StringSession, зашифрован в БД)
                        │
        ┌───────────────┴────────────────┐
        │ Session Manager (SM)           │ legacy GramJS-пул backend
        │ apps/telegram-sessions         │ telegram-mtproto-pool.service.ts
        │ gRPC, consistent-hash sharding │ ТОЛЬКО whitelist-операции (B8)
        │ canary: TELEGRAM_SESSION_      │ + auth-флоу (QR/2FA)
        │ CANARY_PERCENT (dev/prod: 100) │
        └────────────────────────────────┘
```

## Правило №1 — один живой владелец auth key

Два одновременных MTProto-подключения одним auth key → Telegram рвёт **оба** с `406 AUTH_KEY_DUPLICATED` → reconnect-шторм.

- Новая Telegram-операция → **SM RPC** (`packages/proto/hr_helper/v1/telegram-sessions.proto` → `telegram-sessions.controller.ts` → метод в `telegram-session-router.service.ts`). Local GramJS **не расширять**.
- Whitelist `B8_LEGACY_GRAMJS_OPERATIONS` (`telegram-session-guard.util.ts`) — только сокращать. ✅ 2026-07-09 (TG-SM-1): остался только `sendMessageDirect` (для canary<100); `getFolderUnreadCounts` — резолвленные фильтры из `filters_json` SM, `downloadCustomEmoji` — SM RPC.
- **Ownership-lock `tg:owner:{userId}`** (✅ TG-SM-3): оба пула берут лок перед `connect()` — SM в `SessionOwnershipService`, backend в `acquireSessionOwnership` (mtproto-пул). Политика: чужой `sm:*` SM забирает (решардинг), backend делает takeover у SM (auth-флоу приоритетнее, через evict); чужой `backend:*` → 503 «два окружения». Best-effort при недоступном Redis.
- **✅ TG-SM-5 (2026-07-24) — realtime на холодном пуле теперь безопасно опирается на этот лок.** `SessionRealtimeService#watch()` (`apps/telegram-sessions/src/session/session-realtime.service.ts`) раньше на холодном пуле (15-мин eviction / рестарт пода / решардинг) БЕЗУСЛОВНО возвращал пустой завершённый Observable — `getOrCreate` мог поднять второй MTProto-коннект к auth key, которым в этот момент владел backend-GramJS, до появления ownership-лока. Теперь, когда TG-SM-3 гарантирует, что `create()` кидает чистую catchable `Error` вместо второго коннекта при чужом владении, `watch()` на холодном пути сам пробует `SessionDbService.getSessionString` → `SessionPoolService.getOrCreate`: лок свободен → реальный `attach()`, реалтайм оживает без прогревающего RPC от пользователя; лок занят (конфликт владения) → ~~тихий откат к пустому потоку~~ с 2026-09-25 типизированная ошибка: `RealtimeUnavailableError` → gRPC `14 UNAVAILABLE` (circuit OPEN, эвикция, конфликт владения, БД недоступна), `RealtimeNoSessionError` → `9 FAILED_PRECONDITION`; мост backend ретраит с backoff (≤30с, без лимита попыток, «по спросу» не чаще раза в 10с) — пустой «успешный» стрим провоцировал шторм Subscribe. Конкурентные холодные `watch()` одного userId (2 backend-реплики без cross-pod dedup) сериализованы через per-userId `coldConnectLocks` (паттерн `acquireWithLock`). Живая проверка (не только код): рестарт SM-контейнера на реально подключённом аккаунте — backend залогировал `Subscribe stream error … 14 UNAVAILABLE`, автоматический `scheduleResubscribe` переоткрыл поток через ~1с без участия пользователя, SM поднял живой GramJS-коннект и сразу `Realtime subscribed`. Детали: `docs/plans/BACKLOG.md` §TG-SM, `docs/plans/archive/FIX.md`.
- **✅ TG-SM-6 (2026-07-26) — auth-флоу (QR/code/2FA) больше не держит локальный GramJS-клиент тёплым, если SM доступен.** Раньше все 3 auth-пути (`finishQrLoginAfterScan`, `signIn`, `verify2FA` в `telegram-auth.service.ts`) звали `attachConnectedClient` сразу после `saveSession` — это регистрировало клиент в backend-пуле и брало `tg:owner:{userId}` как `backend:*`, а SM (canary 100% в dev/prod) на все последующие запросы этого пользователя оставался заблокирован до истечения TTL — дедлок-окно, где первый post-login запрос через SM тихо деградировал. Теперь все 3 места зовут новый `TelegramMtprotoPoolService#finishAuthHandoff(userId, client)`: если `sessionRouter.shouldRouteUser(userId)` — сразу `AdoptSession` RPC (SM `SessionPoolService.getOrCreate` от только что сохранённой session string, ownership-acquire внутри), успех → локальный клиент немедленно `destroy()`, не регистрируется нигде в backend-пуле; провал/SM недоступен/canary<100 → фолбэк на прежний `attachConnectedClient`, ноль регресса.
- После relogin/logout — `evictSessionBestEffort(userId)` обязателен (уже в `saveSession`).
- `406 AUTH_KEY_DUPLICATED` — это **конфликт владения, не смерть сессии** (✅ TG-SM-2): `isAuthKeyDuplicatedError` отдельно от fatal; обработка в пуле — drop локального клиента → пауза 1.5с → один тихий retry; при повторе 503, НЕ «переподключите Telegram».

## Правило №2 — parse_mode на каждом пути отправки

Потерянный `parse_mode` = получатель видит сырые `<a href>`/`<blockquote>` текстом. Чек-лист путей (все обязаны пробрасывать):

| Путь | Файлы | Регресс-тест (TG-FMT-4, 2026-07-26) |
|---|---|---|
| Текст (REST + Connect) | `telegram-messages.ts` (FE) → `telegram-connect.router.ts` / `telegram-messages.controller.ts` → `telegram-messages-write.service.ts` → SM `SendMessage` | `telegram-messages-write.service.spec.ts` — text×SM, text×legacy (с parseMode и без, ключ `parseMode` отсутствует, не `undefined`) |
| Quote-reply | raw-invoke обходит конвертацию GramJS → обязателен ручной `_parseMessageText` (уже в SM `sendMessage` и `sendMessageDirect`) | `telegram-messages-write.service.spec.ts` — quote-reply×SM (параметры `sessionRouter.sendMessage`), quote-reply×legacy (`_parseMessageText` + entities в raw `Api.messages.SendMessage`) |
| Edit | `EditMessage` (проброшен) | `telegram-messages-write.service.spec.ts` — edit×SM (`sessionRouter.editMessage`), edit×legacy (`client.editMessage` parseOpts), guard на пустой текст |
| Caption файлов | ✅ 2026-07-09 (TG-FMT-2): `parse_mode` в `TgSendFilesRequest` → SM (single+альбом) → вся цепочка; FE сериализует caption через `serializeComposerContent` | `telegram-media-send.service.spec.ts` (новый) — caption×SM (`sessionRouter.sendFiles`), caption×legacy (`client.sendFile` parseOpts, с parseMode и без) |
| Notifications → Telegram | ✅ 2026-07-09 (TG-FMT-3): `sendTelegram` детектит разметку → `parseMode: 'html'` | `notifications.service.spec.ts` (новый, первый спек модуля) — markup-detect→`'html'`, без разметки→`undefined` |
| Шаблоны этапов workflow | ✅ 2026-07-09 (TG-FMT-1): `insertTgFormattedAtCaret` — sanitized HTML-вставка в оба композера + превью в редакторе шаблонов | `telegramComposerSerialize.test.ts` (новый) — сериализация composer→html, auto-link edge case; `insertInContentEditable.test.ts` (новый) — DOMPurify allowlist |

Сериализация композера: `telegramComposerSerialize.ts` (`serializeComposerContent` → `{ text, parseMode: 'html' | undefined }`). Любая программная вставка **форматированного** контента в композер — только как sanitized HTML-фрагмент (DOMPurify, allowlist `b i u s code pre a blockquote tg-spoiler br`), не plain text.

Честная оговорка на весь чек-лист: регресс-покрытие выше — на уровне service-boundary (мокается транспорт: `TelegramSessionRouterService` / GramJS-invoke callback), не live-Telegram/browser e2e — в этом окружении нет тестового Telegram-аккаунта/dev-стенда и Playwright-покрытия Telegram вообще нет. Паттерн — `apps/backend/.../telegram-messages-write.service.spec.ts` (уже существовал до TG-FMT-4). Полный список файлов и счётчик тестов — `docs/plans/DONE.md §Telegram → TG-FMT-4`.

## Правило №3 — peer-резолвинг

`StringSession` **не персистит** entity cache: свежий SM-клиент (после 15-мин eviction `EVICTION_TTL_MS`, рестарта пода, решардинга) не знает ни одного peer.

- `getEntity(числовой id)` / `getInputEntity` без прогрева упадёт → «Пир не найден: N».
- ✅ Паттерн реализован (TG-PEER-1): `getEntityWithWarmup` в SM (прогрев `getDialogs({limit:200})` + отрицательный кэш 45с) — подключён в `GetPeerInfo` и `DownloadPeerAvatar`; новые resolve-точки в SM подключать через него же.
- ✅ TG-PEER-2 (2026-07-26): `access_hash` + `peerType` персистятся в `TelegramUserDialog` при каждом GetDialogs/ingest (оба мэппера — GramJS legacy и SM). `GetPeerInfo`/`DownloadPeerAvatar` принимают опциональный hint и строят `InputPeerUser`/`InputPeerChannel` напрямую (`users.GetUsers`/`channels.GetChannels`, SM `resolveEntityFromHint`), минуя `getDialogs(200)`-прогрев — работает и для peer вне последних 200 диалогов. Фолбэк на `getEntityWithWarmup` при отсутствии/протухшем hint не тронут.
- ✅ Frontend (TG-PEER-3): 400 от peer-info деградирует до данных из списка диалогов, модалка не закрывается.
- ✅ Тип чата рядом с номером (3fcdd…60e2, п. 3, 2026-10-20): номер чата у пользователя, обычной группы и канала
  пересекается, а GramJS по голому номеру отдаёт «пользователь, потом группа, потом канал» — и `EntityCache.get`, и
  `MemorySession.getInputEntity(строка)` (там поиск неточный). Поэтому:
  - новые пути SM резолвят чат только через `resolveChat`/`resolveUser` (`grpc/chat-peer-resolver.ts`), никогда
    `client.getInputEntity(req.*)` или неявное `client.sendMessage(req.chat_id, …)` — это держит инвентарный тест
    `telegram-sessions.controller.peer-type.spec.ts`;
  - backend кладёт в запрос `peer_hint` (`TgPeerHint`, тип из строки диалога аккаунта, `TelegramSessionRouterService.peerHint`);
    тип решает, хэш только ускоряет; без подсказки тип выводится из строк сессии по точному маркированному ключу
    (`getEntityRowsById(ключ, true)`), два типа на номер — отказ `FAILED_PRECONDITION` с текстом
    `TELEGRAM_CHAT_PEER_AMBIGUOUS_MESSAGE` (backend: 409 / Connect `FailedPrecondition`, без отката на GramJS).
  Тип известен (подсказка), а хэша доступа нет ни в сессии, ни после прогрева, ни в подсказке — тот же отказ с текстом
  `TELEGRAM_CHAT_PEER_NOT_FOUND_MESSAGE` (голый номер не пробуется); сбой прогрева не отказ — дальше хэш из подсказки.

## Правило №4 — версии backend ↔ SM

Proto-интерфейсы у backend и SM должны быть из одного коммита. Стейл-образ SM = gRPC 12 UNIMPLEMENTED (уже смягчён редким retry в `telegram-session-subscribe-bridge.service.ts`) или **тихая деградация** (пример: SM без паритета parse_mode слал plain text). При «мистических» симптомах в dev — первым делом `docker compose build telegram-sessions backend`. ✅ Version handshake реализован (TG-SM-4): `build_sha` в `TgSessionStatusResponse` ← `ARG/ENV BUILD_SHA` (Dockerfile + compose); backend сверяет при первом gRPC-клиенте к поду → warn при mismatch.

## Правило №5 — ресурсы и кэши

- Кэш-слои: L1 in-memory `TimedL1Map`/`AvatarL1Map` (TTL + prune + cap) и L2 Redis (всё через `setex`, инвалидация `scanDelete`) — `telegram-cache.service.ts`. Новые кэши — только по этому паттерну: TTL обязателен, unbounded Map запрещён.
- Аватары: MinIO object key + presigned URL (кэш 55 мин, TG-P2-2). **Не возвращать base64 в JSON** — legacy `data:`-ветка только для обратной совместимости.
- **Единственное исключение из per-userId неймспейса** — каталог обоев чата (TG-WALL, ниже): официальный список Telegram одинаков для всех пользователей компании, поэтому кэш (`WALLPAPERS_L1_KEY`/`WALLPAPERS_L2_KEY` в `telegram-cache.service.ts`) — глобальный, без `userId` в ключе. Не копировать этот паттерн для чего-либо реально пользовательского (аватары, диалоги, сообщения — все остаются per-userId); **никогда не кэшировать пустой результат** глобального кэша — источник (SM) сворачивает и «нет сессии у userId», и реальный сбой invoke() в один и тот же пустой ответ, поэтому пустой каталог не персистится (см. `TelegramWallpaperService.fetchAndCacheCatalog`), иначе один транзиентный сбой поразил бы кэш всей компании на 24ч.

## [TG-WALL] Обои чата — официальный каталог Telegram

> Реализовано 2026-07-23. Источник данных — **только** `Api.account.GetWallPapers` через SM (raw MTProto invoke, `client.invoke(new Api.account.GetWallPapers({hash: bigInt(0)}))` в `telegram-sessions.controller.ts#listWallpapers`) — кастомные загрузки пользователя никогда не подмешиваются. Одна настройка на пользователя **на тему приложения** (light/dark — не per-чат), плюс тумблер «замостить» — хранится через существующий cross-device-sync `UiPreferencesCloudSync` (JSON-поле `Profile.extras.ui_preferences.telegram_wallpaper`, без новой Prisma-модели/миграции), по образцу уже существующего `currency_calc`.

- **SM — 2 RPC, не 1** (правка 2026-07-23 после живого репро eviction-шторма, см. `docs/plans/archive/FIX.md`): `ListWallpapers` (`telegram-sessions.controller.ts#listWallpapers`) отдаёт ТОЛЬКО метаданные — один MTProto round-трип, безопасно укладывается в 20с `SessionLivenessInterceptor`-watchdog независимо от размера каталога; различает `Api.WallPaper` (может иметь `document`, `mime_type` — из `Api.Document.mimeType`, известен без скачивания) и `Api.WallPaperNoFile` (только цвет/градиент, `document_id` пуст). Байты ОДНОГО документа — отдельный `DownloadWallpaperDocument(user_id, document_id)`, тем же `downloadMedia(doc, {})`, что и custom-emoji, ограничен watchdog'ом индивидуально, а не суммарно на весь каталог. Первый RPC прогревает `wallpaperDocCache` (TTL 15 мин, cap 500 — паттерн `stickerDocCache`), чтобы второй не гонял повторный полный `GetWallPapers` на каждый документ; промах кэша (решардинг/TTL) — фолбэк `refetchWallpaperDocument` (полный `GetWallPapers`, поиск по `document_id`). **Не возвращать к одному RPC со скачиванием внутри** — это и было причиной бага: bulk-`downloadMedia` внутри одного gRPC-хендлера гарантированно превышает 20с watchdog при catalog size больше пары штук → форс-эвикшн →ретрай с нуля → структурно никогда не завершается.
- **Backend** (`telegram-wallpaper.service.ts`): метаданные из `listWallpapers`, затем недостающие (нет в MinIO) документы качаются через `mapPool` с конкурентностью `TG_WALLPAPER_DOWNLOAD_CONCURRENCY = 4` (не последовательный `for`, не неограниченный `Promise.all` — тот же live GramJS-коннекшен) вызовами `downloadWallpaperDocument` за штуку; сбой ОДНОЙ обоины не роняет весь каталог — запись остаётся с `imageUrl: null` (рендерится как color/gradient, тот же путь, что `WallPaperNoFile`). Скачанные файлы — в MinIO по **глобальному** (не per-userId) ключу `tg/_catalog/wallpapers/{documentId}.{ext}`, presigned URL TTL **24ч** (`TG_WALLPAPER_PRESIGN_TTL_S`) — намеренно равен L2-TTL каталога (`TG_WALLPAPERS_L2_TTL_S`), а не короткому окну аватаров, чтобы presign не мог протухнуть раньше, чем backend сам перевыпустит каталог.
- **Connect** (не REST, read-heavy): `TelegramService.ListWallpapers` в `telegram-connect.router.ts` / `telegram.proto` — `TelegramWallpaperItem.imageUrl` пуст → рендерить из `background*Color`/`intensity`/`rotation` (2 цвета — линейный градиент, 3-4 — приближение; точный проприетарный gradient-mesh Telegram не воспроизводится).
- **Frontend**: обои — это `background` самой `.chatWindowCard` (инлайн-стиль, `apps/frontend/src/features/telegram/telegramWallpaperStyle.ts`), **не** отдельный абсолютно спозиционированный div — так фон гарантированно красится под всеми детьми карточки без манипуляций со stacking context (см. комментарий в файле). Композер поверх обоины получает матовое стекло (`.composerContainerWallpaper`, `TelegramChatsPage.module.css`), непрозрачнее, чем у сайдбара. Выбор обоины хранится по стабильному ключу (`id`/`slug`/составной ключ для чисто цветных обоин) — presigned `imageUrl` никогда не персистится, только резолвится заново из свежего каталога при рендере.
- ✅ Медиа (TG-PERF-2): SM кладёт в MinIO и возвращает object key (байты по gRPC — только fallback без MinIO); горячий путь просмотра — `ensureMediaObjectViaSm` → стрим из MinIO, полный буфер в heap backend'а не материализуется. Buffer-контракт (`downloadMessageMedia`) остаётся для ATS-копий/document-AI.
- SM pool: max 60 клиентов / ~3 GB (`TG_SM_MAX_POOL_SIZE`, compose `memory: 3g`); per-userId circuit breaker реализован в `session-pool.service.ts`.
- FloodWait: через `TelegramFloodWaitService`, не ретраить сквозь FLOOD_WAIT.
- **SM-вотчдог ≠ детектор флуда (2026-09-25).** GramJS спит внутри `invoke()` на FLOOD_WAIT ≤ `floodSleepThreshold` — у SM-клиентов он 10с (дефолт 60с держал RPC дольше 20с вотчдога `SessionLivenessInterceptor`, тот эвиктил здоровую сессию → circuit OPEN на 5 мин = «Telegram перестал работать»). Перед эвикцией вотчдог шлёт MTProto `Ping` (5с): ответил — сессию не трогаем. Не поднимать порог выше вотчдога и не убирать пробу. Ошибки Subscribe — только `RpcException{code}` (`subscribe-rpc-error.ts`), голый `Error` уходит на backend как `2 UNKNOWN`.

## Правило №6 — frontend страницы чатов

- Списки диалогов/сообщений — только виртуализированные (`useVirtualizer`, уже в `TgDialogsList`/`TgMessagesList`/`TgMessageGroupRow`).
- ✅ Infinite-query сообщений (TG-PERF-1): кэш обрезается до последней страницы-курсора после переноса в local state (`useTelegramMessages`); штатный `maxPages` не подходит — prepend-детектор считает новые страницы по росту `pages.length`.
- Хук >500 строк → декомпозиция (сейчас нарушено: `useTelegramChatsPage.ts` 1846, `useTelegramChatsHandlers.ts` 1261 — BACKLOG TG-PERF-3).
- Интерактив в тексте сообщений — через конвейер `renderMessageText.ts` (синтетические entities + data-атрибуты + делегированные обработчики), **не** React-компонент на каждый спан (ломает виртуализацию по памяти). Эталон паттерна — TG-DT: `datetimeRecognizer.ts` (chrono-node lazy-чанком, `referenceDate = msg.date`, мемоизация по messageKey) → entity `type:'datetime'` → поповер одним делегированным обработчиком в `TgMessagesList`. Kill-switch: `localStorage.tg_dt_detect='0'`.
