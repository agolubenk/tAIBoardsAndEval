/**
 * Меню бота: команда /menu (и /start у подписчика), кнопки «m:*», «mo:*», «rs:*», «rep:more:*».
 *
 * Права — как у отчётов (server/telegram/access.ts): нажимает только подписчик с подтверждённым
 * паролем; в группе показ данных — оператор и только в группе-канале консоли; действия (взять в
 * работу, тишина, взять инцидент, проверить сейчас) — роль не ниже оператора; перезапуск контейнера —
 * оператор и только в личке (диалог — server/telegram/restart.ts). Частота: не больше NAV_MAX нажатий
 * в минуту на человека — кнопку «Обновить» можно жать без конца.
 *
 * Навигация правит то же сообщение; если править нельзя (удалено, старое) — новым сообщением.
 */
import { and, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { loginAttempts, monitors } from '../../db/schema'
import { roleAtLeast } from '../../http-types'
import { getEnv } from '../../env'
import { getEgressAllowlist, getGeneralSettings } from '../../settings/store'
import { ackAlert, refreshCardsAfterAction, silenceAlert } from '../../alerts/actions'
import { ackIncident } from '../../incidents/actions'
import { recordCheck, runCheck } from '../../monitors/checks'
import { logActivity } from '../../activity'
import { clock } from '../../lib/time'
import { callBot, TelegramError } from '../api'
import { botToken, type BotRow } from '../store'
import { actorFor, deliveryRefusal, recentCount, refusalAllowed, takeOnce, type Actor } from '../access'
import { afterAnswer, answer, sendCharts, sendReportDetails, startHeavy, type CallbackQuery } from '../actions'
import { RESTART_MIN_ROLE } from '../../containers/restart'
import { cancelRestart, DIALOG_NONCE, startRestart } from '../restart'
import { keyboard, type View, type ViewCtx } from './ui'
import { homeView } from './home'
import { alertsView, alertView, incidentsView, incidentView } from './ops'
import { deploysView, hostByKey, hostView, hostsView, monitorsView, monitorView, tlsView } from './infra'
import { CONTAINER_KEY, containersView, containerView } from './container'
import { reportCached, reportSectionView, SECTION_KEYS } from './report'
import type { ReportSectionKey } from '../../reports/telegram'

const NAV_MAX = 60
const CHECK_COOLDOWN_MS = 15_000

/** Чьи это кнопки: меню, разделы отчёта, «Больше информации» под отчётом. */
export const isMenuCallback = (data: string) => /^(m|mo|rs):/.test(data) || /^rep:more:/.test(data)

async function viewCtx(actor: Actor, chatId: string): Promise<ViewCtx> {
  const { timezone } = await getGeneralSettings()
  const url = getEnv().publicUrl.replace(/\/+$/, '')
  return {
    tz: timezone,
    now: Date.now(),
    operator: roleAtLeast(actor.role, 'operator'),
    restart: roleAtLeast(actor.role, RESTART_MIN_ROLE) && chatId === actor.chatId,
    consoleUrl: /^https:\/\//.test(url) ? url : null,
  }
}

/** Отправить вид новым сообщением (ответом на исходное, если есть). */
async function sendView(bot: BotRow, chatId: string, view: View, replyTo?: number): Promise<void> {
  await callBot(botToken(bot), 'sendMessage', {
    chat_id: chatId,
    text: view.html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard(view.rows),
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  })
}

/** Переписать сообщение под новый вид; «не изменилось» — не ошибка; нельзя править — новым сообщением. */
async function editView(bot: BotRow, chatId: string, messageId: number, view: View): Promise<void> {
  try {
    await callBot(botToken(bot), 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: view.html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard(view.rows),
    })
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    if (/message is not modified/i.test(text)) return
    // Новым сообщением — только если старое править нельзя (удалено, слишком старое). На 429 или
    // ошибке разметки дубль лишь размножил бы сообщения и вызовы API.
    if (/message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(text)) {
      await sendView(bot, chatId, view)
      return
    }
    throw err
  }
}

const NOT_FOUND: View = { html: 'Объект не найден — возможно, уже удалён. Откройте меню заново.', rows: [[{ text: '🏠 Меню', callback_data: 'm:home' }]] }

/** Вид по коду кнопки «m:<вид>[:<id>]» — null, если код не наш. */
async function viewFor(ctx: ViewCtx, code: string, raw: string | null): Promise<View | null | 'missing'> {
  const arg = raw !== null && /^\d{1,12}$/.test(raw) ? Number(raw) : null
  const need = async (v: Promise<View | null>) => (await v) ?? ('missing' as const)
  switch (code) {
    case 'home':
      return homeView(ctx)
    case 'al':
      return alertsView(ctx)
    case 'ar':
      return alertsView(ctx, true)
    case 'in':
      return incidentsView(ctx)
    case 'hs':
      return hostsView(ctx)
    case 'ms':
      return monitorsView(ctx)
    case 'dp':
      return deploysView(ctx)
    case 'tl':
      return tlsView(ctx)
    case 'a':
      return arg === null ? null : need(alertView(ctx, arg))
    case 'i':
      return arg === null ? null : need(incidentView(ctx, arg))
    case 'h':
      return raw === null ? null : need(hostView(ctx, raw))
    case 'hc':
      return raw === null ? null : need(containersView(ctx, raw))
    case 'k':
      return raw === null ? null : need(containerView(ctx, raw))
    case 'c':
      return arg === null ? null : need(monitorView(ctx, arg))
    default:
      return null
  }
}

/** Слот навигации: false — человек жмёт слишком часто. */
async function navAllowed(actor: Actor): Promise<boolean> {
  const key = `tg:rl:nav:${actor.userId}`
  if ((await recentCount(key, 60_000)) >= NAV_MAX) return false
  await getDb().insert(loginAttempts).values({ key, createdAt: new Date() })
  return true
}

/**
 * Новое сообщение от меню в группе — не чаще раза в 10 с: лимит Telegram ~20 сообщений в минуту на
 * группу, а там же идут алерты. В личке хватает общего лимита нажатий.
 */
const postAllowed = (actor: Actor, chatId: string) => (chatId === actor.chatId ? Promise.resolve(true) : takeOnce(`tg:rl:post:${chatId}`, 10_000))

/**
 * Построить отчёт за период, которого нет в кэше: не больше 6 за 5 минут на человека и 30 на
 * всю консоль — иначе подставными периодами в кнопке можно держать вебхук пересчётами.
 */
async function buildAllowed(actor: Actor): Promise<boolean> {
  const mine = `tg:rl:build:${actor.userId}`
  if ((await recentCount(mine, 5 * 60_000)) >= 6 || (await recentCount('tg:rl:build:all', 5 * 60_000)) >= 30) return false
  const at = new Date()
  await getDb().insert(loginAttempts).values([
    { key: mine, createdAt: at },
    { key: 'tg:rl:build:all', createdAt: at },
  ])
  return true
}

/** Право показывать данные в этом чате: в личке — подписчику, в группе — оператору в группе-канале. */
async function chatRefusal(bot: BotRow, actor: Actor, chatId: string): Promise<string | null> {
  if (chatId === actor.chatId) return null
  const denied = await deliveryRefusal(bot, actor, chatId)
  return denied ? denied.replace('Отчёты и графики в группу запрашивает', 'Меню и отчёты в группе открывает').replace('/report, /charts', '/menu') : null
}

/** Команда /menu (и /start у подписчика). false — автор не подписчик. */
export async function handleMenuCommand(bot: BotRow, chatId: string, tgUserId: string): Promise<boolean> {
  const actor = await actorFor(bot, tgUserId)
  if (!actor) return false
  const refusal = await chatRefusal(bot, actor, chatId)
  if (refusal) {
    if (await refusalAllowed(chatId)) await callBot(botToken(bot), 'sendMessage', { chat_id: chatId, text: refusal }).catch(() => undefined)
    return true
  }
  if (!(await navAllowed(actor)) || !(await postAllowed(actor, chatId))) return true
  if (chatId !== actor.chatId) await logActivity('report', `Telegram: меню открыто в группе ${chatId}`, actor.email)
  await sendView(bot, chatId, await homeView(await viewCtx(actor, chatId)))
  return true
}

/** Нажатие кнопки меню. Ответ на нажатие — всегда и ровно один (иначе у человека крутится часик). */
export async function handleMenuCallback(bot: BotRow, cq: CallbackQuery): Promise<void> {
  let answered = false
  const ack = (text = '', alert = false) => {
    answered = true
    return answer(bot, cq.id, text, alert)
  }
  try {
    await route(bot, cq, ack)
  } catch (err) {
    console.warn('[telegram] нажатие меню не обработано:', err instanceof Error ? err.message : err)
    const flood = err instanceof TelegramError && err.code === 429
    const text = flood ? 'Telegram просит подождать — попробуйте через минуту.' : 'Не получилось — попробуйте ещё раз через минуту.'
    // Ответ уже ушёл — второй Telegram отвергнет: сообщаем в чат (кроме 429 — туда сейчас не пишется).
    if (!answered) await ack(text)
    else if (!flood && cq.message) await callBot(botToken(bot), 'sendMessage', { chat_id: String(cq.message.chat.id), text }).catch(() => undefined)
  }
}

type Ack = (text?: string, alert?: boolean) => Promise<void>

/** Работа после ответа (отчёт, проверка): сбой — короткое «не получилось» в чат, а не тишина. */
function later(bot: BotRow, chatId: string, label: string, fn: () => Promise<void>): Promise<void> {
  return afterAnswer(label, async () => {
    try {
      await fn()
    } catch (err) {
      if (!(err instanceof TelegramError && err.code === 429)) {
        await callBot(botToken(bot), 'sendMessage', { chat_id: chatId, text: `Не получилось: ${label} — попробуйте ещё раз.` }).catch(() => undefined)
      }
      throw err
    }
  })
}

const HOST_KEY = '(\\d{1,9}x[0-9a-f]{4})'

async function route(bot: BotRow, cq: CallbackQuery, ack: Ack): Promise<void> {
  const data = cq.data ?? ''
  const chatId = cq.message ? String(cq.message.chat.id) : ''
  const messageId = cq.message?.message_id
  if (!chatId || !messageId || cq.from.is_bot) return ack()
  const actor = await actorFor(bot, String(cq.from.id))
  if (!actor) return ack('Только для админов консоли с подключённым Telegram (Настройки → Профиль).', true)
  const refusal = await chatRefusal(bot, actor, chatId)
  if (refusal) return ack(refusal, true)

  // Тяжёлое — через общую очередь отчётов и графиков (свои лимиты частоты).
  const all = /^rs:all:(\d{7,9})$/.exec(data)
  if (all) {
    const refused = await startHeavy(bot, actor, chatId, 'more', () => sendReportDetails(bot, chatId, Number(all[1]), messageId))
    return ack(refused?.text ?? 'Готовлю весь отчёт…', refused?.alert ?? false)
  }
  const charts = new RegExp(`^m:hg:${HOST_KEY}$`).exec(data)
  if (charts) {
    const host = await hostByKey(charts[1]!)
    if (!host) return ack('Сервер не найден — откройте список серверов заново.')
    const refused = await startHeavy(bot, actor, chatId, 'charts', () => sendCharts(bot, chatId, undefined, { id: host.agent.id, name: host.agent.name }))
    return ack(refused?.text ?? 'Рисую графики хоста…', refused?.alert ?? false)
  }

  if (!(await navAllowed(actor))) return ack('Слишком быстро — подождите минуту.')

  // Перезапуск контейнера: права, контейнер и очередь — проверяются заново на каждом шаге диалога.
  const restart = new RegExp(`^m:kr:${CONTAINER_KEY}$`).exec(data)
  if (restart) {
    const res = await startRestart(bot, actor, String(cq.from.id), chatId, restart[1]!)
    return ack(res.text, res.alert ?? false)
  }
  const cancel = new RegExp(`^m:kx:${DIALOG_NONCE}$`).exec(data)
  if (cancel) {
    const res = await cancelRestart(bot, String(cq.from.id), chatId, messageId, cancel[1]!)
    return ack(res.text, res.alert ?? false)
  }

  const ctx = await viewCtx(actor, chatId)

  // Подробный отчёт: построение — после ответа (вебхук с max_connections=1 не ждёт), за период не из
  // кэша — с лимитом построений.
  const period = /^(?:rep:more|rs:([a-z]{2,3})):(\d{7,9})$/.exec(data)
  if (period) {
    const key = (period[1] ?? 'sum') as ReportSectionKey
    if (!(SECTION_KEYS as readonly string[]).includes(key)) return ack()
    const cached = reportCached(Number(period[2]), ctx.now)
    if (!cached && !(await buildAllowed(actor))) return ack('Слишком много отчётов подряд — подождите пару минут.')
    const posting = data.startsWith('rep:more:')
    if (posting && !(await postAllowed(actor, chatId))) return ack('Только что открывали — смотрите выше в чате.')
    if (posting && chatId !== actor.chatId) await logActivity('report', `Telegram: подробный отчёт открыт в группе ${chatId}`, actor.email)
    await ack(cached ? '' : 'Готовлю отчёт…')
    return later(bot, chatId, 'подробный отчёт', async () => {
      const view = await reportSectionView(ctx, key, Number(period[2]))
      await (posting ? sendView(bot, chatId, view, messageId) : editView(bot, chatId, messageId, view))
    })
  }

  // «mo:<вид>[:<id>]» — тот же вид новым сообщением (кнопки под пуш-карточкой алерта, под отчётом).
  const open = /^mo:([a-z]{1,4})(?::(\w{1,16}))?$/.exec(data)
  if (open) {
    if (!(await postAllowed(actor, chatId))) return ack('Только что открывали — смотрите выше в чате.')
    const view = await viewFor(ctx, open[1]!, open[2] ?? null)
    if (!view) return ack()
    if (chatId !== actor.chatId) await logActivity('report', `Telegram: меню открыто в группе ${chatId}`, actor.email)
    await ack()
    return sendView(bot, chatId, view === 'missing' ? NOT_FOUND : view, messageId)
  }

  const act = /^m:(aa|am|ia|cc):(\d{1,12})$/.exec(data)
  if (act) return action(bot, ack, actor, ctx, act[1] as 'aa' | 'am' | 'ia' | 'cc', Number(act[2]), chatId, messageId)

  const nav = /^m:([a-z]{1,4})(?::(\w{1,16}))?$/.exec(data)
  if (!nav) return ack()
  const view = await viewFor(ctx, nav[1]!, nav[2] ?? null)
  if (!view) return ack()
  await ack()
  return editView(bot, chatId, messageId, view === 'missing' ? NOT_FOUND : view)
}

/** Действия из карточек меню: ответ — сразу, правка карточек алертов в других чатах — после. */
async function action(
  bot: BotRow,
  ack: Ack,
  actor: Actor,
  ctx: ViewCtx,
  kind: 'aa' | 'am' | 'ia' | 'cc',
  id: number,
  chatId: string,
  messageId: number,
): Promise<void> {
  if (!ctx.operator) return ack('Нужна роль оператора консоли.', true)
  const via = ' (из Telegram)'
  if (kind === 'aa' || kind === 'am') {
    const done = kind === 'aa' ? await ackAlert(id, actor.email, via) : await silenceAlert(id, 60, actor.email, via, { extendOnly: true })
    if (!done) {
      await ack('Алерт уже закрыт.')
    } else if (done.already) {
      await ack(
        kind === 'am'
          ? `Тишина уже стоит — до ${clock(done.row.silencedUntil?.getTime() ?? ctx.now, ctx.tz)}.`
          : done.row.acknowledgedBy === actor.email
            ? 'Вы уже взяли этот алерт.'
            : `Уже в работе у ${done.row.acknowledgedBy ?? 'другого админа'}.`,
      )
    } else {
      await ack(kind === 'aa' ? 'Взято в работу — повторы по алерту остановлены.' : 'Тишина на 1 час.')
      await afterAnswer('карточки алерта', () => refreshCardsAfterAction(done.row))
    }
    const view = await alertView({ ...ctx, now: Date.now() }, id)
    return editView(bot, chatId, messageId, view ?? NOT_FOUND)
  }
  if (kind === 'ia') {
    const done = await ackIncident(id, actor.email, { via, refreshCards: false })
    if (!done) return ack('Инцидент не найден.')
    if (done.closed) {
      await ack('Инцидент уже закрыт.')
    } else {
      await ack(done.assigned ? 'Инцидент ваш — алерты в работе.' : done.acked ? `В работе: алертов ${done.acked}.` : 'Уже подтверждён.')
      await afterAnswer('карточки алертов инцидента', async () => {
        for (const row of done.rows) await refreshCardsAfterAction(row)
      })
    }
    return editView(bot, chatId, messageId, (await incidentView({ ...ctx, now: Date.now() }, id)) ?? NOT_FOUND)
  }
  // «Проверить сейчас»: не чаще раза в 15 с на монитор (проверка — внешний запрос до таймаута).
  const m = await getDb().query.monitors.findFirst({ where: and(eq(monitors.id, id), eq(monitors.enabled, true)) })
  if (!m) return ack('Проверка не найдена или выключена.')
  if (!(await takeOnce(`tg:rl:check:${id}`, CHECK_COOLDOWN_MS))) return ack('Проверка только что была — подождите 15 секунд.')
  await ack('Проверяю…')
  return later(bot, chatId, 'проверка', async () => {
    await recordCheck(m, await runCheck(m, await getEgressAllowlist()))
    await editView(bot, chatId, messageId, (await monitorView({ ...ctx, now: Date.now() }, id)) ?? NOT_FOUND)
  })
}
