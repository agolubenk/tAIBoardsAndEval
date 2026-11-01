---
paths:
  - apps/backend/src/app/hr-helper-io.adapter.ts
  - apps/backend/src/common/realtime/**
  - apps/backend/src/modules/notifications/**
  - apps/backend/src/modules/candidate-applications/bulk-actions/**
  - apps/backend/src/modules/extension/controllers/**
  - apps/backend/src/modules/mcp/mcp.controller.ts
  - apps/backend/src/modules/interviews/controllers/interviews-copilot.controller.ts
  - apps/backend/src/modules/executive-council/controllers/executive-gateway.controller.ts
  - apps/backend/src/common/outbox/**
  - apps/backend/src/common/events/**
  - apps/telegram-sessions/**
---

# Real-time, SSE & Live Streaming

## B-64 — новый канал реалтайма → WebSocket по умолчанию, не SSE

Owner-декизн 2026-09-01: полная миграция транспорта реалтайма на WebSocket. SSE
ticket-auth (`POST /auth/sse-ticket` → `?ticket=`) остаётся **только** для `GET
/mcp/sse` — это wire-транспорт самого протокола MCP (JSON-RPC поверх SSE), которым
говорят внешние клиенты (Claude Desktop и т.п.); заменить нельзя без разрыва
совместимости с ними. Везде остальном — `RealtimeGateway` (`/ws`, JWT в
`handshake.auth.token`, не в query) + `RealtimeService.emitToUser`/`emitToCompany`.

Почему WS, а не ticket-SSE, для нового канала: WS избегает round-trip за тикетом
(1 лишний HTTP-запрос + Redis SETEX/GETDEL на каждое открытие соединения),
переиспользует уже открытый сокет (один коннект на клиента на всё — meньше
соединений на сервере и в браузере), и push происходит в момент мутации, а не на
следующем poll-тике — что почти всегда быстрее и почти всегда дешевле, чем
periodic-poll SSE (см. пример ниже, ATS bulk-actions: было 1.5с poll на каждый
открытый диалог, стало push из процессора без опроса вовсе).

Первая мигрированная поверхность — ATS bulk-actions (`AtsBulkActionService.
updateJobProgress` → `emitToUser(createdByUserId, 'ats-bulk-action', job)`,
фронт — `useAtsBulkActionStream.ts`, снимок при подписке через `GET jobs/:jobId`,
дальше только дельты по WS). `AtsBulkActionStreamService` (poll-SSE) удалён — не
заводить заново.

✅ Prep для `user-notifications` завершён (2026-09-02): все 9 мест, создающих
`AppNotification` через Prisma, теперь эмитят `emitToUser(userId, 'notification',
toNotificationRealtimePayload(created))` (`notification-realtime.util.ts` — общая
форма payload, не дублировать по местам). 2 места (`NotificationsService.sendInApp`,
`WellbeingPulseService.deliverPulseInvite`) уже это делали — рефакторены на общую
утилиту; 7 реально были пропущены и исправлены: `evaluation-nudge.service.ts`,
`evaluation-post-action.service.ts` (`handleNotifyHr`),
`vacancy-automation-dedup-actions.service.ts` (`mergePrompt`),
`vacancy-automation-notification-actions.service.ts` (`notifyRecruiter` +
`createRecruiterTask`), `rule-delivery.service.ts` (`deliverWebNotification`),
`vacancy-meeting-feedback-reminder.service.ts`, `hitl-escalation.scheduler.ts`.
Последние два — `createMany({skipDuplicates: true})` в периодических cron-джобах: `id`
теперь генерируется клиентом (`randomUUID()`, `createMany` возвращает только
`{count}`), и перед вставкой/эмитом — pre-filter по уже существующим `uniqueId`, иначе
каждый повторный тик крона re-push'ил бы «новое» уведомление тем, кто его уже получил.

✅ WS-эмит для 10 авто-генераторов `user-notifications` добавлен (2026-09-02,
аддитивно): `UserNotificationsService.refresh()`/`refreshHrTimeTrackingOnly()` —
каждый upsert теперь фан-аутит в ДВА независимых канала при `createdAt === updatedAt`
(свежесозданная строка, та же проверка, что у `PushDispatchService.notifyIfFresh` для
APNs): `pushDispatch.notifyIfFresh(row)` (мобильный push) и новый
`emitFreshRealtime(row)` → `emitToUser(userId, 'notification',
toNotificationRealtimePayload(row))` (WS). Оба вызова изолированы друг от друга
(`emitFreshRealtime` глотает и логирует собственные ошибки) — сбой одного канала не
должен гасить другой. Транспорт-триггер (когда вообще запускается `refresh()`) этим
НЕ тронут: SSE-тик/`getForUser()` работают как раньше — это чисто аддитивный слой,
паттерн «сначала добавить, потом снести старое» как в ATS bulk-actions.

✅ **B-73 закрыт (2026-09-03):** `UserNotificationsCronFallbackScheduler`
(`user-notifications-cron-fallback.scheduler.ts`) — 4-й, независимый триггер того же
`refresh()` (throttle-гвард внутри `refresh()` координирует его с
`getForUser()`/SSE-тиком), `@Cron('*/15 * * * *')`, скоуплен на пользователей с хотя
бы одним `MobileDeviceToken` (иначе push всё равно некуда слать) — пагинация по
`take:100` за страницу, до 20 страниц за тик. Пользователь без живой веб-сессии
(только мобильное приложение) теперь получает автогенерируемые уведомления и
мобильный push не реже раза в 15 минут, а не «никогда до следующего открытия
веб-приложения».

✅ **Фронт `user-notifications` переписан на WS-consumer (2026-09-03):**
`useNotificationStream.ts` больше не открывает `EventSource` — подписывается на
`getSocket().on('notification', ...)` и инвалидирует `notificationQueryKeys.all` (тот
же эффект, что раньше давал SSE `'update'`-эвент, но мгновенно, а не на следующем
60с-тике). `useRealtimeInvalidation.ts` удалён — был единственным потребителем, после
переписывания хука остался без вызывающих.

⚠️ **SSE-роут (`UserNotificationsStreamService`) СНЯТ С ОЧЕРЕДИ, не сносить не
разобравшись:** у 60с-тика этого сервиса ДВЕ роли, не одна — (1) сообщить фронту, что
есть обновления (эту роль теперь закрывает WS-эвент выше) и (2) быть периодическим
ТРИГГЕРОМ САМОЙ ГЕНЕРАЦИИ — именно тик дёргает `refresh()`, который читает источники
(календарь, SLA и т.д.) и апсертит новые `AppNotification` для ТЕКУЩЕГО онлайн-
пользователя, если у него открыта живая SSE-сессия. B-73 (cron-фолбэк, `*/15 * * * *`)
закрывает роль (2) только для пользователей с зарегистрированным mobile push токеном —
онлайн-пользователь БЕЗ токена (десктоп/веб-таб открыта, колокольчик не открывался)
после сноса SSE потерял бы автогенерацию вовсе (только on-demand при заходе в
колокольчик, никакого периодического sweep). Сносить SSE-роут можно только после
отдельного решения по роли (2) для этого сегмента пользователей — не тот же PR, что
переписывание хука.

✅ **Backend-prep для `workflow-chat` завершён (2026-09-03, аддитивно):**
`WorkflowChatEventPublisherService.pushEvent`/`streamTokens` теперь дополнительно
эмитят `RealtimeService.emitToUser(userId, 'workflow-chat', { chatId, ...event })` —
SSE-poll (Redis rpush → `WorkflowChatStreamService` → `EventSource`) не тронут,
фронтенд-хуки (`useWorkflowChatStream.ts`, `useWorkflowNewBackendChat.ts`) всё ещё
читают только SSE, переключение на WS-consumer — отдельный следующий шаг. `userId` —
это пользователь, чьё действие породило событие (постящий/turn actor), не
`companyId`: первая версия этого прохода эмитила в `company:{companyId}` (по аналогии
с `resume-parse-job.service.ts`), это поймал адверсариальный ревью до мержа — приватный
контент чата (токены, tool_call, HITL-брифы) утекал бы всем сотрудникам компании, не
только владельцу чата. Исправлено на `emitToUser`, тот же паттерн, что
`useAtsBulkActionStream`/`ats-bulk-action.service.ts` (таргетить владельца ресурса, не
компанию целиком). `WorkflowChatService.requireChat` гарантирует `userId === chat.
ownerUserId` для любого owned-чата (`createChat` всегда ставит `ownerUserId` — оба
входа, `workflow-chat.controller.ts` и `extension-workflow-chat.controller.ts`);
`ownerUserId` может стать `null` только через `ON DELETE SET NULL` при удалении
владельца — редкий случай, для него WS сужается до текущего актёра вместо всех
зрителей осиротевшего чата, но SSE по-прежнему покрывает всех (не регрессия, т.к. WS-
потребителей ещё нет). Попутно найден и НЕ тронут (вне скоупа, отдельная находка):
`WorkflowChatJobCallbackService` — мёртвый код, нигде не зарегистрирован в DI, пишет в
Redis напрямую мимо `WorkflowChatEventPublisherService` — если его когда-нибудь
подключат, событие `agent_complete` из него не долетит по WS без отдельного фикса.

**Дальше (мигрировать по одному, не пачкой):** переключить фронтенд-хуки
`workflow-chat` на WS-consumer (backend готов); затем `interviews-copilot` (тот же
двухшаговый паттерн — backend-prep, потом фронт); extension workflow-chat/ats
(браузерный `EventSource`, отдельная задача — расширение не использует
`socket.io-client` вовсе, там нужен отдельный клиент).

## Socket.io — Redis Adapter (ОБЯЗАТЕЛЬНО при prod/staging)

✅ **Статус (сверено с кодом 2026-07-08): активирован** — `apps/backend/src/app/hr-helper-io.adapter.ts` использует `createAdapter(pubClient, subClient)`. При изменениях adapter **не отключать**: при N>1 подах без него WS-сообщения от Pod A не доходят до клиентов Pod B. Ниже — эталонный паттерн.

```typescript
// apps/backend/src/app/hr-helper-io.adapter.ts — эталон (уже реализовано)
import { createAdapter } from '@socket.io/redis-adapter'
import Redis from 'ioredis'

export class HrHelperIoAdapter extends IoAdapter {
  private adapterConstructor!: ReturnType<typeof createAdapter>

  async connectToRedis(redisHost: string, redisPort: number): Promise<void> {
    const pubClient = new Redis(redisPort, redisHost)
    const subClient = pubClient.duplicate()
    await Promise.all([
      new Promise(r => pubClient.once('connect', r)),
      new Promise(r => subClient.once('connect', r)),
    ])
    this.adapterConstructor = createAdapter(pubClient, subClient)
  }

  createIOServer(port: number, options?: any) {
    const server = super.createIOServer(port, {
      pingInterval: 25_000,
      pingTimeout: 5_000,
      ...options,
    })
    server.adapter(this.adapterConstructor)
    return server
  }
}
```

Вызвать в `main.ts`: `await adapter.connectToRedis(config.REDIS_HOST, config.REDIS_PORT)`

## SSE — обязательный heartbeat

Актуально для оставшихся SSE-поверхностей (см. список «на очереди» выше) и для
`/mcp/sse` (постоянно, не мигрирует). Каждые 25 секунд отправлять `:ping` для
предотвращения разрыва соединения:

```typescript
// Правильный паттерн (mcp.controller.ts)
@Get('watch')
async watchEvents(@Req() req: Request, @Res() res: Response) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // ✅ Heartbeat
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(':ping\n\n')
  }, 25_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    // очистить Redis подписки, Subject, etc.
  })

  // Отправить событие
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}
```

✅ Свип PERF-SSE-1 (2026-07-27): на тот момент все 7 SSE-поверхностей (5 `@Sse` + raw `extension-ats`/`mcp`) проходили чек-лист ticket/heartbeat/cleanup. С 2026-09-01 (B-64) поверхностей 6 — `ats-bulk-actions` мигрирован на WS, счёт закрывается по мере миграции остальных (см. секцию B-64 выше). Poll-based стримы — через `common/sse/sse-poll-stream.util.ts` (`createSsePollStream`), учёт активных стримов — `hr_helper_sse_streams_active` на `/metrics`.

## SSE — горизонтальное масштабирование через Redis pub/sub

❌ Сейчас: SSE соединение к конкретному поду; событие из Pod A не доходит до SSE-клиента Pod B.

```typescript
// При публикации события (любой под)
await this.redis.publish(`sse:company:${companyId}`, JSON.stringify({
  type: eventType,
  payload,
  timestamp: new Date().toISOString(),
}))

// При открытии SSE соединения
async openSseStream(companyId: string, req: Request, res: Response) {
  const sub = this.redis.duplicate()
  const channel = `sse:company:${companyId}`
  await sub.subscribe(channel)

  sub.on('message', (ch, message) => {
    if (!res.writableEnded) res.write(`data: ${message}\n\n`)
  })

  req.on('close', async () => {
    await sub.unsubscribe(channel)
    sub.disconnect()
  })
}
```

## SSE — auth pattern (ticket-based, не Bearer в query)

Применимо к оставшимся SSE-каналам (см. список «на очереди» выше) и к `/mcp/sse`
(постоянно). Для нового канала реалтайма — WS handshake-auth (см. секцию B-64
выше), а не этот паттерн.

```typescript
// ✅ Для SSE (пока не мигрирован на WS)
// 1. Получить одноразовый ticket
POST /api/v1/auth/sse-ticket → { ticket: 'one-time-uuid' }  // TTL 30s в Redis

// 2. Использовать ticket в SSE URL
GET /api/v1/extension/ats/watch?ticket=<uuid>

// ❌ ЗАПРЕЩЕНО для SSE (Bearer token в URL — попадает в логи)
GET /api/v1/watch?token=eyJhbGciOiJIUzI1NiJ9...

// ✅ Для WS (новый канал по умолчанию) — JWT в handshake, не в URL
io(url, { auth: { token: `Bearer ${accessToken}` } })  // apps/frontend/src/shared/realtime/socket.ts
```

## Transactional Outbox — double-processing protection

❌ Сейчас: несколько подов могут одновременно взять одни outbox-записи.

```typescript
// common/outbox/outbox.service.ts — claimBatch() должен использовать FOR UPDATE SKIP LOCKED
async claimBatch(limit = 50): Promise<OutboxEvent[]> {
  return this.db.$queryRaw<OutboxEvent[]>`
    UPDATE integration_outbox
    SET status = 'processing', processing_started_at = NOW()
    WHERE id IN (
      SELECT id FROM integration_outbox
      WHERE status = 'pending'
        AND next_attempt_at <= NOW()
      ORDER BY created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`
}
```

## Domain Events — cross-pod fan-out

❌ Сейчас: `@nestjs/event-emitter` работает только внутри одного процесса.
При N>1 подах listener на Pod A не получит событие с Pod B.

```typescript
// Паттерн для cross-pod событий:
// 1. Сохранить событие в outbox внутри той же транзакции
// 2. Outbox processor публикует в BullMQ
// 3. BullMQ worker (все поды) обрабатывают

// Для немедленной доставки (не критичной) — Redis pub/sub
await this.redis.publish('domain:events', JSON.stringify({
  type: 'CANDIDATE_CREATED',
  payload,
  companyId,
}))
```

Кафка (kafkajs установлен) — рассмотреть для высоконагруженных потоков событий, но текущий масштаб не требует.

## WebSocket rooms — соглашение

```typescript
// При подключении клиент joinит rooms:
socket.join(`company:${companyId}`)   // все события компании
socket.join(`user:${userId}`)          // персональные уведомления

// При emit события:
this.server.to(`company:${companyId}`).emit('event', data)
this.server.to(`user:${userId}`).emit('notification', notification)
```

## Telegram gRPC — circuit breaker

✅ **Реализован** (сверено 2026-07-08): per-userId circuit breaker в `apps/telegram-sessions/src/session/session-pool.service.ts` (3 неудачных reconnect → OPEN на 5 мин → HALF_OPEN). Ниже — концептуальный паттерн; правила владения сессией и parse_mode — `.claude/rules/16-telegram.md`.

```typescript
// apps/telegram-sessions/src/session/session-pool.service.ts
// Circuit breaker state (реализован)
enum CircuitState { CLOSED, OPEN, HALF_OPEN }

class CircuitBreaker {
  private state = CircuitState.CLOSED
  private failures = 0
  private lastFailure?: Date

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      const elapsed = Date.now() - this.lastFailure!.getTime()
      if (elapsed > 5 * 60 * 1000) {  // 5 min backoff
        this.state = CircuitState.HALF_OPEN
      } else {
        throw new Error('Circuit OPEN — session unavailable')
      }
    }
    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (e) {
      this.onFailure()
      throw e
    }
  }
}
```

## Notifications — не stub, реализовать полностью

❌ Обнаружено в аудите: `notifications.service.ts` — `sendInApp` и `sendEmail` только логируют.

```typescript
// sendInApp → WebSocket broadcast
async sendInApp(params: SendInAppParams): Promise<void> {
  this.server.to(`user:${params.recipient}`).emit('notification', {
    type: params.type,
    title: params.title,
    body: params.body,
    url: params.url,
  })
}

// sendEmail → BullMQ queue (не блокирующий HTTP)
async sendEmail(params: SendEmailParams): Promise<void> {
  await this.emailQueue.add('send', params, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  })
}

// sendTelegram → BullMQ queue
async sendTelegram(params: SendTelegramParams): Promise<void> {
  await this.telegramQueue.add('send', params, { attempts: 2 })
}
```
