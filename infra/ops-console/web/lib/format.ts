const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' })

export function timeAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  const s = Math.round((ms - now) / 1000)
  const abs = Math.abs(s)
  if (abs < 45) return abs < 5 ? 'только что' : rtf.format(s, 'second')
  if (abs < 2700) return rtf.format(Math.round(s / 60), 'minute')
  if (abs < 79_200) return rtf.format(Math.round(s / 3600), 'hour')
  return rtf.format(Math.round(s / 86_400), 'day')
}

/** Компактно для лент: «сейчас», «5 мин», «3 ч», «2 дн». */
export function timeShort(ms: number | null | undefined, now = Date.now()): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  const sec = Math.max(0, Math.round((now - ms) / 1000))
  if (sec < 45) return 'сейчас'
  if (sec < 3600) return `${Math.round(sec / 60)} мин`
  if (sec < 86_400) return `${Math.round(sec / 3600)} ч`
  return `${Math.round(sec / 86_400)} дн`
}

export function dateTime(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function fullDateTime(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function duration(fromMs: number, toMs: number = Date.now()): string {
  const min = Math.max(0, Math.round((toMs - fromMs) / 60_000))
  if (min < 1) return '< 1 мин'
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} ч ${min % 60} мин`
  return `${Math.floor(h / 24)} дн ${h % 24} ч`
}

/** Точная длительность: «13 мин 22 с», «2 ч 5 мин», «3 дн 4 ч». */
export function preciseDuration(fromMs: number, toMs: number = Date.now()): string {
  const sec = Math.max(0, Math.round((toMs - fromMs) / 1000))
  if (sec < 60) return `${sec} с`
  if (sec < 3600) return `${Math.floor(sec / 60)} мин ${sec % 60} с`
  return duration(fromMs, toMs)
}

export { incidentCode } from '../../shared/codes'

export function uptimeSec(sec: number | undefined): string {
  if (!sec) return '—'
  const d = Math.floor(sec / 86_400)
  const h = Math.floor((sec % 86_400) / 3600)
  return d ? `${d} дн ${h} ч` : `${h} ч ${Math.floor((sec % 3600) / 60)} мин`
}

export function pct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '—' : `${v.toFixed(digits).replace(/\.0+$/, '')}%`
}

export function mb(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return v >= 1024 ? `${(v / 1024).toFixed(1)} ГБ` : `${Math.round(v)} МБ`
}

/** Объём в байтах: 1,2 ГБ, 340 МБ, 12 КБ. */
export function bytes(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  if (v >= 1_073_741_824) return `${(v / 1_073_741_824).toFixed(1)} ГБ`
  if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(v >= 10_485_760 ? 0 : 1)} МБ`
  if (v >= 1024) return `${Math.round(v / 1024)} КБ`
  return `${Math.round(v)} Б`
}

export function bytesPerSec(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(1)} МБ/с`
  if (v >= 1024) return `${(v / 1024).toFixed(0)} КБ/с`
  return `${Math.round(v)} Б/с`
}

export function compact(v: number): string {
  return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
}
