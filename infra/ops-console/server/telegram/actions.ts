/**
 * Действия из Telegram: кнопки под отчётами и карточками алертов, команды /report и /charts.
 *
 * Кто может: только доставляемая подписка (учётка активна, пароль бота подтверждён) — по from.id
 * нажавшего. В личке — любой такой подписчик (отчёт он и так видит в консоли). В группе — это уже
 * рассылка: роль не ниже оператора (как «Отправить отчёт» в консоли) и только в группе, подключённой
 * каналом консоли с тем же ботом; каждая такая отправка — в журнал. Действия над алертом — роль не
 * ниже оператора. Тяжёлое (отчёт, графики) — не чаще раза в минуту на чат, не больше 5 за 5 минут
 * на человека и по одному за раз на всю консоль: кнопку могут жать много раз подряд, а растр
 * графиков синхронный и занимает процесс.
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { loginAttempts } from '../db/schema'
import { roleAtLeast } from '../http-types'
import { actorFor, deliveryRefusal, recentCount, refusalAllowed, type Actor } from './access'
import { rememberReport } from './menu/report'
import { ackAlert, refreshCardsAfterAction, silenceAlert } from '../alerts/actions'
import { logActivity } from '../activity'
import { buildReport } from '../reports/build'
import { buildSnapshots } from '../reports/charts'
import { detailHtmlParts, digestHtml, reportKeyboard } from '../reports/telegram'
import { getGeneralSettings } from '../settings/store'
import { escapeHtml } from '../notify/format'
import { clock } from '../lib/time'
import { callBot, callBotMultipart, TelegramError } from './api'
import { botToken, type BotRow } from './store'

const PER_ACTOR = { max: 5, windowMs: 5 * 60_000 }

/**
 * Занять слот: раз в минуту на чат и вид, не больше PER_ACTOR на человека. Возвращает «вернуть
 * слот чата» — при сбое работы, чтобы человек мог сразу повторить, а не ждать минуту. Личный
 * лимит не возвращается: иначе сбой за сбоем давал бы бесконечные повторы тяжёлой работы.
 */
async function takeSlot(kind: HeavyKind, chatId: string, actor: Actor): Promise<(() => Promise<void>) | string> {
  const chatKey = `tg:rl:${kind}:${chatId}`
  const actorKey = `tg:rl:actor:${actor.userId}`
  if ((await recentCount(chatKey, 60_000)) > 0) return `${kind === 'charts' ? 'Графики' : 'Отчёт'} уже запрашивали меньше минуты назад — смотрите выше в чате.`
  if ((await recentCount(actorKey, PER_ACTOR.windowMs)) >= PER_ACTOR.max) return 'Слишком много запросов — попробуйте через пару минут.'
  const at = new Date()
  const db = getDb()
  const [chatRow] = await db
    .insert(loginAttempts)
    .values([
      { key: chatKey, createdAt: at },
      { key: actorKey, createdAt: at },
    ])
    .returning({ id: loginAttempts.id })
  return async () => {
    if (chatRow) await db.delete(loginAttempts).where(eq(loginAttempts.id, chatRow.id))
  }
}

export async function send(bot: BotRow, chatId: string, html: string, extra: Record<string, unknown> = {}): Promise<void> {
  await callBot(botToken(bot), 'sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra })
}

/** Свежий отчёт за последние сутки — карточкой с кнопками. */
export async function sendUrgentReport(bot: BotRow, chatId: string): Promise<void> {
  const { timezone } = await getGeneralSettings()
  const report = await buildReport('daily')
  rememberReport(report)
  await send(bot, chatId, digestHtml(report, timezone, { urgent: true }), { reply_markup: reportKeyboard(report, { urgent: true }) })
}

/** Конец периода по кнопке: не в будущем и не старше 30 дней (старше данных уже нет). */
function clampEnd(endMin: number | undefined, now = Date.now()): number {
  if (endMin === undefined) return now
  return Math.min(Math.max(endMin * 60_000, now - 30 * 86_400_000), now)
}

/** Подробный отчёт за сутки, заканчивающиеся в endMin (не раньше 30 дней назад: старше данных уже нет). */
export async function sendReportDetails(bot: BotRow, chatId: string, endMin: number, replyTo?: number): Promise<void> {
  const { timezone } = await getGeneralSettings()
  const report = await buildReport('daily', new Date(clampEnd(endMin)))
  const parts = detailHtmlParts(report, timezone)
  for (const [i, part] of parts.entries()) {
    await send(bot, chatId, part, i === 0 && replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {})
  }
}

/**
 * Снимки графиков за сутки, заканчивающиеся в endMin (кнопка под отчётом — тот же период, что в
 * отчёте; команда — последние сутки), альбомом (2–10 картинок; одна — обычным фото).
 */
export async function sendCharts(bot: BotRow, chatId: string, endMin?: number, host?: { id: string; name: string }): Promise<void> {
  const { timezone } = await getGeneralSettings()
  const end = clampEnd(endMin)
  const shots = (await buildSnapshots(timezone, end, host?.id)).slice(0, 10)
  if (!shots.length) {
    await send(bot, chatId, `📈 Графиков нет: за эти сутки ${host ? `агент «${escapeHtml(host.name)}» не прислал` : 'агенты не прислали'} метрик. Проверьте агентов в консоли.`)
    return
  }
  const period = `${clock(end - 86_400_000, timezone, end)} → ${clock(end, timezone, end)}`
  const caption = `📈 ${host ? `${host.name} · ` : ''}графики ${period}: ${shots.map((x) => x.caption.replace(/ за сутки$/, '')).join(', ')}`
  const files = shots.map((s) => ({ field: s.name, filename: `${s.name}.png`, contentType: 'image/png', data: s.png }))
  if (shots.length === 1) {
    const [only] = files
    await callBotMultipart(botToken(bot), 'sendPhoto', { chat_id: chatId, caption }, [{ ...only!, field: 'photo' }], 60_000)
    return
  }
  const media = shots.map((s, i) => ({ type: 'photo', media: `attach://${s.name}`, ...(i === 0 ? { caption } : {}) }))
  await callBotMultipart(botToken(bot), 'sendMediaGroup', { chat_id: chatId, media }, files, 60_000)
}

/** В тестах — синхронно (результат проверяется сразу), в работе — после ответа вебхуку. */
let syncForTests = false
export function setTelegramSyncForTests(v: boolean): void {
  syncForTests = v
}

/**
 * Работа после ответа на нажатие (правка карточек, проверка монитора): вебхук с max_connections=1
 * держит остальные апдейты, пока не ответим. В тестах — сразу, чтобы проверить результат.
 */
export async function afterAnswer(label: string, fn: () => Promise<unknown>): Promise<void> {
  const run = () =>
    fn().catch((err: unknown) => {
      console.warn(`[telegram] ${label} не выполнено:`, err instanceof Error ? err.message : err)
    })
  if (syncForTests) await run()
  else setImmediate(() => void run())
}

/**
 * Тяжёлые задачи — по одной на всю консоль, очередь не длиннее MAX_PENDING: процесс консоли
 * обслуживает и агентов, и проверки, а растр графиков синхронный. Telegram ждёт ответ на вебхук,
 * и с max_connections=1 остальные апдейты стоят за ним — поэтому работа идёт после ответа.
 * Процесс живёт постоянно (docker), отложенное доводится до конца; ошибки — в журнал процесса.
 */
const MAX_PENDING = 3
let pending = 0
let chain: Promise<void> = Promise.resolve()

/** false — очередь полна; иначе промис завершения (в тестах его ждут, в работе — нет). */
function enqueue(label: string, fn: () => Promise<void>): false | Promise<void> {
  if (pending >= MAX_PENDING) return false
  pending++
  const run = async () => {
    try {
      await fn()
    } catch (err) {
      console.warn(`[telegram] ${label} не выполнено:`, err instanceof Error ? err.message : err)
    } finally {
      pending--
    }
  }
  chain = syncForTests ? chain.then(run) : chain.then(() => new Promise<void>((resolve) => setImmediate(() => void run().then(resolve))))
  return chain
}

export interface CallbackQuery {
  id: string
  from: { id: number; is_bot?: boolean }
  message?: { message_id: number; chat: { id: number; type: string } }
  data?: string
}

export async function answer(bot: BotRow, id: string, text = '', alert = false): Promise<void> {
  await callBot(botToken(bot), 'answerCallbackQuery', { callback_query_id: id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => undefined)
}

export type HeavyKind = 'now' | 'more' | 'charts'

const HEAVY_LABEL: Record<HeavyKind, string> = { now: 'срочный отчёт', more: 'подробный отчёт', charts: 'графики' }

/**
 * Поставить тяжёлую задачу: проверка права на чат, слот частоты, очередь. Возвращает текст отказа
 * или null; при сбое самой работы слот возвращается и в чат уходит короткое «не получилось».
 */
/** Отказ: текст и всплывающее окно (права — окно, частота и занятость — короткая подсказка). */
export interface Refusal {
  text: string
  alert: boolean
}

export async function startHeavy(bot: BotRow, actor: Actor, chatId: string, kind: HeavyKind, work: () => Promise<void>): Promise<Refusal | null> {
  const denied = await deliveryRefusal(bot, actor, chatId)
  if (denied) return { text: denied, alert: true }
  const slot = await takeSlot(kind, chatId, actor)
  if (typeof slot === 'string') return { text: slot, alert: false }
  const queued = enqueue(`rep:${kind}`, async () => {
    try {
      await work()
      if (chatId !== actor.chatId) await logActivity('report', `Telegram: ${HEAVY_LABEL[kind]} отправлен в группу ${chatId}`, actor.email)
    } catch (err) {
      // 429 — Telegram просит подождать: повтор сразу только удлинит ожидание, слот не возвращаем.
      const flood = err instanceof TelegramError && err.code === 429
      if (!flood) {
        await slot()
        await send(bot, chatId, `Не получилось подготовить ${HEAVY_LABEL[kind]} — попробуйте ещё раз.`).catch(() => undefined)
      }
      throw err
    }
  })
  if (!queued) {
    await slot()
    return { text: 'Консоль занята другими отчётами — попробуйте через минуту.', alert: false }
  }
  if (syncForTests) await queued
  return null
}

/**
 * «rep:now», «rep:charts[:<мин>]» (без минут — кнопки отчётов, отправленных до привязки к периоду).
 * «rep:more:<мин>» («Больше информации») — уже не здесь: его открывает меню (server/telegram/menu).
 */
const REP = /^rep:(?:(now)|(more):(\d{7,9})|(charts)(?::(\d{7,9}))?)$/

/** Нажатие кнопки. Ответ на callback — всегда (иначе у человека ~15 с крутится часик), даже при сбое. */
export async function handleCallback(bot: BotRow, cq: CallbackQuery): Promise<void> {
  try {
    await handleCallbackInner(bot, cq)
  } catch (err) {
    console.warn('[telegram] нажатие не обработано:', err instanceof Error ? err.message : err)
    await answer(bot, cq.id, 'Не получилось — попробуйте ещё раз через минуту.')
  }
}

/** Ответ на callback — сразу (у Telegram ~15 с), работа — после. */
async function handleCallbackInner(bot: BotRow, cq: CallbackQuery): Promise<void> {
  const data = cq.data ?? ''
  const chatId = cq.message ? String(cq.message.chat.id) : ''
  if (!chatId || cq.from.is_bot) return answer(bot, cq.id)
  const actor = await actorFor(bot, String(cq.from.id))
  if (!actor) return answer(bot, cq.id, 'Только для админов консоли с подключённым Telegram (Настройки → Профиль).', true)

  const rep = REP.exec(data)
  if (rep) {
    const kind: HeavyKind = rep[1] ? 'now' : rep[2] ? 'more' : 'charts'
    const endMin = rep[3] ?? rep[5]
    const work =
      kind === 'now'
        ? () => sendUrgentReport(bot, chatId)
        : kind === 'charts'
          ? () => sendCharts(bot, chatId, endMin ? Number(endMin) : undefined)
          : () => sendReportDetails(bot, chatId, Number(endMin), cq.message?.message_id)
    const refusal = await startHeavy(bot, actor, chatId, kind, work)
    return answer(bot, cq.id, refusal?.text ?? (kind === 'charts' ? 'Рисую графики…' : 'Готовлю отчёт…'), refusal?.alert ?? false)
  }

  const m = /^al:(ack|mute):(\d{1,12})$/.exec(data)
  if (m) {
    if (!roleAtLeast(actor.role, 'operator')) return answer(bot, cq.id, 'Нужна роль оператора консоли.', true)
    const id = Number(m[2])
    const isAck = m[1] === 'ack'
    const done = isAck ? await ackAlert(id, actor.email, ' (из Telegram)') : await silenceAlert(id, 60, actor.email, ' (из Telegram)', { extendOnly: true })
    if (!done) return answer(bot, cq.id, 'Алерт уже закрыт.')
    if (done.already) {
      if (!isAck) {
        const { timezone } = await getGeneralSettings()
        const until = done.row.silencedUntil?.getTime() ?? Date.now()
        return answer(bot, cq.id, `Тишина уже стоит — до ${clock(until, timezone)}.`)
      }
      return answer(bot, cq.id, done.row.acknowledgedBy === actor.email ? 'Вы уже взяли этот алерт.' : `Уже в работе у ${done.row.acknowledgedBy ?? 'другого админа'}.`)
    }
    await answer(bot, cq.id, isAck ? 'Взято в работу — повторы по алерту остановлены.' : 'Тишина на 1 час.')
    const text = isAck ? `✋ Взято в работу: ${escapeHtml(actor.email)}` : `🔕 Тишина на 1 час — ${escapeHtml(actor.email)}`
    await send(bot, chatId, text, cq.message ? { reply_parameters: { message_id: cq.message.message_id, allow_sending_without_reply: true } } : {}).catch(
      () => undefined,
    )
    // Карточки во всех чатах — после ответа: правка каждой — сетевой вызов, а вебхук ждёт.
    if (syncForTests) await refreshCardsAfterAction(done.row)
    else setImmediate(() => void refreshCardsAfterAction(done.row))
    return
  }
  return answer(bot, cq.id)
}

/**
 * Команды /report и /charts (личка подписчика или группа). false — автор не подписчик: в личке
 * ему подсказывают привязку, в группе бот молчит (незнакомцам не отвечает).
 */
export async function handleReportCommand(bot: BotRow, chatId: string, tgUserId: string, command: 'report' | 'charts'): Promise<boolean> {
  const actor = await actorFor(bot, tgUserId)
  if (!actor) return false
  const kind: HeavyKind = command === 'report' ? 'now' : 'charts'
  const refusal = await startHeavy(bot, actor, chatId, kind, () => (kind === 'now' ? sendUrgentReport(bot, chatId) : sendCharts(bot, chatId)))
  // Отказ в группе — не чаще раза в 5 минут на чат (частота самого отчёта ограничена и так).
  if (refusal && (chatId === actor.chatId || !refusal.alert || (await refusalAllowed(chatId)))) {
    await send(bot, chatId, escapeHtml(refusal.text)).catch(() => undefined)
  }
  return true
}

export { actorFor, type Actor }
