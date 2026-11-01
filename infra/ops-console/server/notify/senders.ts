/**
 * Отправители по типу канала. Секреты приходят расшифрованными из dispatch и дальше не живут.
 * Новый тип канала = новая функция здесь + схема конфигурации в channel-config.ts.
 */
import nodemailer from 'nodemailer'
import { hmacHex } from '../lib/crypto'
import { httpRequest } from '../lib/http'
import { callBot } from '../telegram/api'
import { getEgressAllowlist } from '../settings/store'
import type { ChannelKind } from '../db/schema'

export interface OutgoingMessage {
  subject: string
  text: string
  html: string
  /** Структурированное тело для webhook. */
  payload: Record<string, unknown>
  /** message_id сообщения, на которое это — ответ (ветка алерта). Понимает только Telegram. */
  replyTo?: number
  /** Кнопки под сообщением (inline_keyboard). Понимает только Telegram. */
  replyMarkup?: Record<string, unknown>
}

export interface ChannelConfig {
  [key: string]: unknown
}

/** Отправитель возвращает id сообщения в канале, если канал его даёт (Telegram — message_id). */
type Sender = (config: ChannelConfig, secret: Record<string, string>, msg: OutgoingMessage) => Promise<string | null>

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * Лимит Telegram — 4096 символов. Режем по границе строки: каждая строка alertHtml закрывает
 * свои теги, а обрезка посреди `<b>…` или `&amp;` даёт 400 «can't parse entities» — и алерт
 * теряется, а все правки карточки падают.
 */
export function fitTelegram(html: string, max = 4000): string {
  if (html.length <= max) return html
  const cut = html.lastIndexOf('\n', max - 2)
  return `${html.slice(0, cut > 0 ? cut : max - 2)}\n…`
}

async function telegramCall(
  secret: Record<string, string>,
  method: string,
  body: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<unknown> {
  return callBot(secret.botToken ?? '', method, body, timeoutMs)
}

const sendTelegram: Sender = async (config, secret, msg) => {
  const chatId = str(config.chatId)
  if (!chatId) throw new Error('не задан токен бота или chat id')
  const result = await telegramCall(secret, 'sendMessage', {
    chat_id: chatId,
    text: fitTelegram(msg.html),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    // Исходное сообщение могли удалить — тогда ответ уходит обычным сообщением, а не ошибкой.
    ...(msg.replyTo ? { reply_parameters: { message_id: msg.replyTo, allow_sending_without_reply: true } } : {}),
    ...(msg.replyMarkup ? { reply_markup: msg.replyMarkup } : {}),
  })
  const id = (result as { message_id?: unknown } | undefined)?.message_id
  return typeof id === 'number' ? telegramRef(telegramChatId(config), id) : null
}

/**
 * Ссылка на сообщение — «chatId:messageId». message_id уникален только внутри чата: после смены
 * chatId у канала старый id указывал бы на чужое сообщение нового чата (ответ не туда, правка
 * чужой карточки). Ссылка годится, только если чат совпадает с текущим.
 */
export const telegramRef = (chatId: string, messageId: number) => `${chatId}:${messageId}`

export function messageIdInChat(ref: string, chatId: string): number | null {
  const i = ref.lastIndexOf(':')
  if (i <= 0 || ref.slice(0, i) !== chatId) return null
  const id = Number(ref.slice(i + 1))
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * Пространство ссылок на сообщения. У канала — его chat id; у личной подписки — «botId/chatId»:
 * chat id лички равен id пользователя и не меняется при смене бота, а message_id старого бота в
 * чате нового — чужие.
 */
export const telegramChatId = (config: ChannelConfig) => str(config.refScope) || str(config.chatId)

/**
 * Переписать уже отправленное сообщение (карточка алерта: актуальный статус, время, факты).
 * «message is not modified» — не ошибка: текст уже такой. Удалённое сообщение — ошибка, её
 * глотает вызывающий: правка — косметика, ответ в ветке уже ушёл. Таймаут короткий: уведомления
 * о контейнерах уходят внутри отчёта агента, а агент ждёт ответа не дольше 30 с.
 */
export async function editTelegram(
  config: ChannelConfig,
  secret: Record<string, string>,
  messageId: number,
  html: string,
  replyMarkup?: Record<string, unknown>,
): Promise<void> {
  try {
    await telegramCall(
      secret,
      'editMessageText',
      {
        chat_id: str(config.chatId),
        message_id: messageId,
        text: fitTelegram(html),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        // Без reply_markup правка снимает кнопки — поэтому передаём их каждый раз (итоговая карточка — без кнопок действий).
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
      },
      3_000,
    )
  } catch (err) {
    if (err instanceof Error && /message is not modified/i.test(err.message)) return
    throw err
  }
}

const sendEmail: Sender = async (config, secret, msg) => {
  const host = str(config.host)
  const to = str(config.to)
  if (!host || !to) throw new Error('не задан SMTP-хост или получатели')
  const port = Number(config.port) || 587
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: config.secure === true || port === 465,
    auth: str(config.user) ? { user: str(config.user), pass: secret.password ?? '' } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  })
  await transport.sendMail({ from: str(config.from) || str(config.user), to, subject: msg.subject, text: msg.text })
  return null
}

/** Подпись webhook: `X-Ops-Signature: sha256=HMAC(secret, "${timestamp}.${body}")`. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${hmacHex(secret, `${timestamp}.${body}`)}`
}

const sendWebhook: Sender = async (config, secret, msg) => {
  const url = str(config.url)
  const key = secret.signingSecret
  if (!url) throw new Error('не задан URL')
  if (!key) throw new Error('не задан ключ подписи — webhook без HMAC запрещён')
  const body = JSON.stringify(msg.payload)
  const ts = String(Date.now())
  const res = await httpRequest(url, {
    allowPrivateHosts: await getEgressAllowlist(),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ops-Timestamp': ts, 'X-Ops-Signature': signWebhook(key, ts, body) },
    body,
    timeoutMs: 10_000,
  })
  if (res.status < 200 || res.status >= 300) throw new Error(`webhook ответил HTTP ${res.status}`)
  return null
}

export const SENDERS: Record<ChannelKind, Sender> = {
  telegram: sendTelegram,
  email: sendEmail,
  webhook: sendWebhook,
}
