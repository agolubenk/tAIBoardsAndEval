/** Время для людей: часовой пояс консоли (Настройки → Общие), русские длительности. */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function parts(ms: number, tz: string): { day: string; time: string; seconds: string } {
  const f = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(ms)
  const get = (t: Intl.DateTimeFormatPartTypes) => f.find((p) => p.type === t)?.value ?? ''
  return { day: `${get('day')}.${get('month')}`, time: `${get('hour')}:${get('minute')}`, seconds: get('second') }
}

/** «15:03» сегодня, «06.10 15:03» в другой день (по часовому поясу консоли). */
export function clock(ms: number, tz: string, now = Date.now(), withSeconds = false): string {
  const p = parts(ms, tz)
  const t = withSeconds ? `${p.time}:${p.seconds}` : p.time
  return p.day === parts(now, tz).day ? t : `${p.day} ${t}`
}

/** «< 1 мин», «5 мин», «2 ч 10 мин», «3 дн 4 ч». */
export function humanDuration(ms: number): string {
  // Вниз: «длится 1 мин» с 60 до 119 с, меньше минуты — «< 1 мин».
  const min = Math.max(0, Math.floor(ms / 60_000))
  if (min < 1) return '< 1 мин'
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  if (h < 48) return min % 60 ? `${h} ч ${min % 60} мин` : `${h} ч`
  return `${Math.floor(h / 24)} дн ${h % 24} ч`
}
