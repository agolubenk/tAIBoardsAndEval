/**
 * Проверка initData Telegram Mini App (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 * secret = HMAC_SHA256(key="WebAppData", msg=botToken); hash = hex(HMAC_SHA256(secret, data-check-string)),
 * где data-check-string — все поля, кроме hash, по алфавиту, «key=value» через \n.
 * Подделать без токена бота нельзя; auth_date ограничивает повтор перехваченной строки.
 */
import { createHmac } from 'node:crypto'
import { safeEqual } from '../lib/crypto'

/** Mini App открыта не раньше этого — время на ввод пароля с запасом, но не «вечная» строка. */
const MAX_AGE_SEC = 10 * 60

export interface MiniAppUser {
  tgUserId: string
}

export function verifyInitData(initData: string, botToken: string, nowMs = Date.now()): MiniAppUser | null {
  if (!initData || initData.length > 4096) return null
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null
  const pairs: string[] = []
  for (const [k, v] of params) if (k !== 'hash') pairs.push(`${k}=${v}`)
  pairs.sort()
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const expected = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex')
  if (!safeEqual(expected, hash)) return null
  const authDate = Number(params.get('auth_date'))
  if (!Number.isFinite(authDate) || nowMs / 1000 - authDate > MAX_AGE_SEC || authDate - nowMs / 1000 > 60) return null
  try {
    const user = JSON.parse(params.get('user') ?? '') as { id?: unknown; is_bot?: unknown }
    if (typeof user.id !== 'number' || user.is_bot === true) return null
    return { tgUserId: String(user.id) }
  } catch {
    return null
  }
}

/** Для тестов: подписать initData так же, как Telegram. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex')
  const p = new URLSearchParams(fields)
  p.set('hash', hash)
  return p.toString()
}
