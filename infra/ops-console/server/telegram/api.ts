/**
 * Вызов Telegram Bot API. Один источник для отправителей уведомлений, вебхука и настроек бота.
 *
 * Токен — только в URL запроса к api.telegram.org: в текст ошибки он не попадает (describeError
 * httpRequest не печатает путь), в журнал — тем более. 429 с коротким retry_after повторяется один
 * раз: при шторме алертов лимит чата (≈1 сообщение/с) срабатывает именно на таких паузах.
 */
import { httpRequest } from '../lib/http'

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter: number | null,
  ) {
    super(message)
  }

  /** Бот заблокирован пользователем, аккаунт удалён или чат исчез — писать туда больше бессмысленно. */
  get unreachable(): boolean {
    return this.code === 403 || (this.code === 400 && /chat not found|user is deactivated/i.test(this.message))
  }
}

interface BotResponse {
  ok?: boolean
  description?: string
  error_code?: number
  result?: unknown
  parameters?: { retry_after?: number }
}

const MAX_RETRY_AFTER_SEC = 5

export async function callBot(token: string, method: string, body: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
  if (!token) throw new TelegramError('Telegram: не задан токен бота', 0, null)
  for (let attempt = 0; ; attempt++) {
    const res = await httpRequest(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs,
      maxBytes: 1024 * 1024,
    })
    let parsed: BotResponse = {}
    try {
      parsed = JSON.parse(res.text) as BotResponse
    } catch {
      /* тело не JSON — ниже ошибка по коду */
    }
    if (res.ok && parsed.ok !== false) return parsed.result
    const code = parsed.error_code ?? res.status
    const retryAfter = parsed.parameters?.retry_after ?? null
    if (code === 429 && retryAfter !== null && retryAfter <= MAX_RETRY_AFTER_SEC && attempt === 0) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000))
      continue
    }
    throw new TelegramError(`Telegram: ${parsed.description ?? `HTTP ${res.status}`}`, code, retryAfter)
  }
}

export const TOKEN_FORMAT = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/

export interface BotIdentity {
  id: string
  username: string
}

export async function getMe(token: string): Promise<BotIdentity> {
  const me = (await callBot(token, 'getMe')) as { id?: number; username?: string } | undefined
  if (!me?.id) throw new TelegramError('Telegram: непонятный ответ getMe', 0, null)
  return { id: String(me.id), username: me.username ?? '' }
}

export interface WebhookInfo {
  url: string
  pendingUpdates: number
  lastErrorDate: number | null
  lastErrorMessage: string | null
}

export async function getWebhookInfo(token: string): Promise<WebhookInfo> {
  const r = (await callBot(token, 'getWebhookInfo')) as {
    url?: string
    pending_update_count?: number
    last_error_date?: number
    last_error_message?: string
  }
  return {
    url: r?.url ?? '',
    pendingUpdates: r?.pending_update_count ?? 0,
    lastErrorDate: r?.last_error_date ? r.last_error_date * 1000 : null,
    lastErrorMessage: r?.last_error_message ?? null,
  }
}

export interface UploadFile {
  /** Имя поля формы (для sendMediaGroup — то, на что ссылается attach://<field>). */
  field: string
  filename: string
  contentType: string
  data: Buffer
}

/**
 * Вызов с файлами (multipart/form-data): sendPhoto, sendMediaGroup. Поля-объекты уходят JSON-строкой,
 * как требует Bot API (media, reply_markup).
 */
export async function callBotMultipart(
  token: string,
  method: string,
  fields: Record<string, unknown>,
  files: UploadFile[],
  timeoutMs = 30_000,
): Promise<unknown> {
  if (!token) throw new TelegramError('Telegram: не задан токен бота', 0, null)
  const boundary = `----hrhops${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    const value = typeof v === 'string' ? v : JSON.stringify(v)
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${value}\r\n`))
  }
  for (const f of files) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`),
      f.data,
      Buffer.from('\r\n'),
    )
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  const res = await httpRequest(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
    timeoutMs,
    maxBytes: 1024 * 1024,
  })
  let parsed: BotResponse = {}
  try {
    parsed = JSON.parse(res.text) as BotResponse
  } catch {
    /* ниже — по коду */
  }
  if (res.ok && parsed.ok !== false) return parsed.result
  throw new TelegramError(`Telegram: ${parsed.description ?? `HTTP ${res.status}`}`, parsed.error_code ?? res.status, parsed.parameters?.retry_after ?? null)
}
