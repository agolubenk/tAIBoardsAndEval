/**
 * Перезапуск контейнера из бота — пошаговый диалог в личке: «Перезапустить» в карточке контейнера →
 * причина сообщением → у контейнера с данными — его точное имя → команда тем же путём, что из консоли
 * (requestRestart: роль, причина, имя, очередь, пауза — там; здесь не повторяются, бот лишь решает по
 * отказу, о чём спросить дальше) → ответ со статусом и кнопкой к карточке контейнера.
 *
 * Состояние диалога — в settings (`tg-dialog:<Telegram id>`, как мигание алертов): переживает
 * рестарт процесса и serverless. Живёт 10 минут с начала — как неподтверждённая команда агенту. Шаг
 * забирает его атомарно (DELETE … RETURNING): повтор апдейта не обработается дважды. На каждом шаге
 * заново: подписка доставляемая, тот же человек, роль не ниже оператора (её проверяет и requestRestart).
 * Текст сообщений в журнал процесса не пишется — причина попадает только в ленту событий консоли.
 */
import { and, eq, like, lt } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { settings } from '../db/schema'
import { COMMAND_TTL_MS } from '../containers/commands'
import { assertCanRestart, checkRestartable, requestRestart, RestartRefusal, type RestartQueued } from '../containers/restart'
import { randomToken } from '../lib/crypto'
import { callBot } from './api'
import { actorFor, type Actor } from './access'
import { containerByKey, containerKeyFor } from './menu/container'
import { cb, e, keyboard, type Button } from './menu/ui'
import { botToken, type BotRow } from './store'

const PREFIX = 'tg-dialog:'
const dialogKey = (tgUserId: string) => `${PREFIX}${tgUserId}`

/** Код кнопки «Отменить»: случайный на каждый диалог — кнопка прошлого диалога не отменит текущий. */
export const DIALOG_NONCE = '([A-Za-z0-9_-]{8})'

const dialogSchema = z.object({
  kind: z.literal('restart'),
  nonce: z.string(),
  /** Учётка консоли: перепривязка Telegram к другой учётке не продолжает чужой диалог. */
  userId: z.number().int(),
  agentId: z.string(),
  container: z.string(),
  step: z.enum(['reason', 'confirm']),
  reason: z.string().default(''),
  expiresAt: z.number(),
})
type Dialog = z.infer<typeof dialogSchema>

function parseDialog(value: string | undefined): Dialog | null {
  if (value === undefined) return null
  try {
    const parsed = dialogSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function putDialog(tgUserId: string, d: Dialog): Promise<void> {
  const value = JSON.stringify(d)
  await getDb()
    .insert(settings)
    .values({ key: dialogKey(tgUserId), value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}

async function peekDialog(tgUserId: string, now = Date.now()): Promise<Dialog | null> {
  const row = await getDb().query.settings.findFirst({ where: eq(settings.key, dialogKey(tgUserId)) })
  const d = parseDialog(row?.value)
  return d && d.expiresAt > now ? d : null
}

/** Забрать диалог (удалить и вернуть): шаг обрабатывает ровно один апдейт. */
async function takeDialog(tgUserId: string, now = Date.now()): Promise<Dialog | 'expired' | null> {
  const [row] = await getDb().delete(settings).where(eq(settings.key, dialogKey(tgUserId))).returning({ value: settings.value })
  const d = parseDialog(row?.value)
  if (!d) return null
  return d.expiresAt > now ? d : 'expired'
}

/** Брошенные диалоги — из чистки тика (истёкший удаляется и при следующем сообщении человека). */
export async function pruneDialogs(now = Date.now()): Promise<void> {
  await getDb()
    .delete(settings)
    .where(and(like(settings.key, `${PREFIX}%`), lt(settings.updatedAt, new Date(now - COMMAND_TTL_MS))))
}

function send(bot: BotRow, chatId: string, html: string, rows?: Button[][]): Promise<unknown> {
  return callBot(botToken(bot), 'sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(rows ? { reply_markup: keyboard(rows) } : {}),
  })
}

const cancelRow = (d: Dialog): Button[] => [cb('✖️ Отменить', `m:kx:${d.nonce}`)]
const target = (container: string, agentName: string) => `<b>${e(container)}</b> на <b>${e(agentName)}</b>`

export interface Ack {
  text: string
  alert?: boolean
}

/** Кнопка «Перезапустить» в карточке контейнера: проверки, диалог, вопрос о причине. Возвращает ответ на нажатие. */
export async function startRestart(bot: BotRow, actor: Actor, tgUserId: string, chatId: string, key: string): Promise<Ack> {
  if (chatId !== actor.chatId) return { text: 'Перезапуск — только в личном чате с ботом: там я спрошу причину.', alert: true }
  let checked: Awaited<ReturnType<typeof checkRestartable>>
  try {
    assertCanRestart(actor)
    const found = await containerByKey(key)
    if (!found) return { text: 'Контейнер не найден — откройте список контейнеров заново.' }
    checked = await checkRestartable(found.agentId, found.name)
  } catch (err) {
    if (err instanceof RestartRefusal) return { text: err.message, alert: true }
    throw err
  }
  const { agent, ctr } = checked
  const live = await peekDialog(tgUserId)
  if (live && live.userId === actor.userId && live.agentId === ctr.agentId && live.container === ctr.name) {
    return { text: live.step === 'reason' ? 'Уже жду причину — напишите её сообщением.' : 'Уже жду имя контейнера — отправьте его сообщением.' }
  }
  const d: Dialog = {
    kind: 'restart',
    nonce: randomToken(6),
    userId: actor.userId,
    agentId: ctr.agentId,
    container: ctr.name,
    step: 'reason',
    reason: '',
    expiresAt: Date.now() + COMMAND_TTL_MS,
  }
  await putDialog(tgUserId, d)
  const lines = [
    `🔁 <b>Перезапуск</b> ${target(ctr.name, agent.name)}`,
    '',
    'Напишите причину одним сообщением (3–300 символов): она попадёт в ленту событий, хронологию инцидента и отчёт ИИ-совету.',
  ]
  if (ctr.stateful) lines.push('🗄 Контейнер хранит данные — после причины попрошу ввести его имя.')
  lines.push(`<i>Диалог действует ${COMMAND_TTL_MS / 60_000} минут.</i>`)
  try {
    await send(bot, chatId, lines.join('\n'), [cancelRow(d)])
  } catch (err) {
    // Вопрос не дошёл — диалога нет: иначе следующее сообщение человека стало бы причиной.
    await takeDialog(tgUserId)
    throw err
  }
  return { text: '' }
}

/** Кнопка «Отменить» под вопросом. */
export async function cancelRestart(bot: BotRow, tgUserId: string, chatId: string, messageId: number, nonce: string): Promise<Ack> {
  const taken = await takeDialog(tgUserId)
  if (!taken || taken === 'expired') return { text: 'Отменять нечего — диалог уже завершён.' }
  if (taken.nonce !== nonce) {
    await putDialog(tgUserId, taken)
    return { text: 'Эта кнопка — от прошлого диалога; текущий не тронут.' }
  }
  await callBot(botToken(bot), 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: `✖️ Перезапуск <b>${e(taken.container)}</b> отменён — команда не создана.`,
    parse_mode: 'HTML',
  }).catch(() => undefined)
  return { text: 'Отменено' }
}

/**
 * Сообщение подписчика в личке — шаг диалога, если он идёт. false — диалога нет (или он уже не этого
 * человека): с сообщением поступают как раньше.
 */
export async function handleRestartMessage(bot: BotRow, tgUserId: string, chatId: string, text: string): Promise<boolean> {
  const taken = await takeDialog(tgUserId)
  if (!taken) return false
  if (taken === 'expired') {
    await send(bot, chatId, `⌛ Время на перезапуск вышло (${COMMAND_TTL_MS / 60_000} минут) — команда не создана. Начать заново — кнопкой «Перезапустить» в карточке контейнера.`)
    return true
  }
  const actor = await actorFor(bot, tgUserId)
  if (!actor || actor.userId !== taken.userId || actor.chatId !== chatId) return false
  let queued: RestartQueued
  try {
    queued = await requestRestart(actor, {
      agentId: taken.agentId,
      container: taken.container,
      reason: taken.step === 'reason' ? text : taken.reason,
      confirmName: taken.step === 'confirm' ? text : undefined,
      channel: 'telegram',
    })
  } catch (err) {
    if (err instanceof RestartRefusal) {
      await onRefusal(bot, tgUserId, chatId, taken, text, err)
      return true
    }
    console.warn('[telegram] перезапуск из бота не поставлен:', err instanceof Error ? err.message : err)
    await send(bot, chatId, 'Не получилось поставить команду — попробуйте ещё раз кнопкой «Перезапустить» в карточке контейнера.').catch(() => undefined)
    return true
  }
  // Команда уже в очереди: сбой этого ответа её не отменяет — статус виден в карточке контейнера.
  const key = await containerKeyFor(taken.agentId, taken.container)
  await send(
    bot,
    chatId,
    [
      `✅ Команда #${queued.commandId} в очереди: перезапуск ${target(queued.container, queued.agentName)}.`,
      'Агент выполнит её со следующим отчётом — обычно в течение 15 секунд. Чем кончилось — в карточке контейнера.',
    ].join('\n'),
    key ? [[cb('📦 Статус контейнера', `m:k:${key}`)]] : undefined,
  )
  return true
}

/** Отказ requestRestart: неверная причина — спросить снова; нужно имя — спросить имя; остальное — конец диалога. */
async function onRefusal(bot: BotRow, tgUserId: string, chatId: string, d: Dialog, text: string, err: RestartRefusal): Promise<void> {
  if (err.kind === 'reason' && d.step === 'reason') {
    await putDialog(tgUserId, d)
    await send(bot, chatId, `${e(err.message)}. Напишите причину ещё раз — или нажмите «Отменить».`, [cancelRow(d)])
    return
  }
  if (err.kind === 'confirm' && d.step === 'reason') {
    await putDialog(tgUserId, { ...d, step: 'confirm', reason: text })
    await send(
      bot,
      chatId,
      `🗄 Контейнер <b>${e(d.container)}</b> хранит данные: перезапуск оборвёт соединения и транзакции сервисов, которые от него зависят. Чтобы подтвердить, отправьте его имя полностью: <code>${e(d.container)}</code>`,
      [cancelRow(d)],
    )
    return
  }
  // Дальше диалог окончен: неверное имя, нет прав, контейнер пропал, уже в очереди, пауза.
  const key = err.kind === 'confirm' || err.kind === 'in_flight' || err.kind === 'cooldown' ? await containerKeyFor(d.agentId, d.container) : null
  if (err.kind === 'confirm') {
    await send(
      bot,
      chatId,
      `⛔️ Имя не совпало с <b>${e(d.container)}</b> — перезапуск отменён, команда не создана.`,
      key ? [[cb('🔁 Начать заново', `m:kr:${key}`)]] : undefined,
    )
    return
  }
  await send(bot, chatId, `⛔️ ${e(err.message)} — команда не создана.`, key ? [[cb('📦 Статус контейнера', `m:k:${key}`)]] : undefined)
}
