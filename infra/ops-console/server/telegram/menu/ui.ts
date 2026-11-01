/**
 * Меню бота — общие кирпичи: вид (HTML + кнопки), иконки состояний, навигация, обрезка строк.
 *
 * Навигация правит ОДНО сообщение (editMessageText): список → карточка → «назад», без новой ленты в
 * чате. callback_data ≤ 64 байт: «m:<вид>[:<id>]» — перейти/обновить на месте, «mo:<вид>» — открыть
 * новым сообщением (кнопки под отчётом и карточками, которые сами не переписываются), «rs:<раздел>:<мин>» —
 * раздел подробного отчёта, «m:kr:<контейнер>» / «m:kx:<диалог>» — начать и отменить перезапуск.
 */
import { escapeHtml } from '../../notify/format'
import { clock } from '../../lib/time'
import type { UiStatus } from '../../routes/status'

export interface Button {
  text: string
  callback_data?: string
  url?: string
}

export interface View {
  html: string
  rows: Button[][]
}

/** Кто смотрит и где: роль (кнопки действий — от оператора), часовой пояс, адрес консоли (https). */
export interface ViewCtx {
  tz: string
  now: number
  operator: boolean
  /** Кнопка «Перезапустить»: оператор в личке с ботом — причину бот спрашивает сообщением, в группе так нельзя. */
  restart: boolean
  /** Ссылки «Открыть в консоли» — только при https-адресе (Telegram отвергает localhost). */
  consoleUrl: string | null
}

export const e = escapeHtml

export const STATUS_ICON: Record<UiStatus, string> = {
  healthy: '🟢',
  warning: '🟠',
  critical: '🔴',
  unknown: '⚪️',
  pending: '⏳',
  maintenance: '🛠',
}

export const STATUS_LABEL: Record<UiStatus, string> = {
  healthy: 'в норме',
  warning: 'внимание',
  critical: 'критично',
  unknown: 'нет данных',
  pending: 'ждёт подключения',
  maintenance: 'техработы',
}

/** Подпись кнопки — Telegram обрезает длинные сам, но некрасиво: режем по-своему. */
export function short(s: string, max = 32): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export const at = (ctx: ViewCtx) => `<i>на ${e(clock(ctx.now, ctx.tz, ctx.now, true))}</i>`

export const cb = (text: string, data: string): Button => ({ text, callback_data: data })

/** Ссылка в консоль (только https). */
export function consoleButton(ctx: ViewCtx, path: string, text = '🔗 В консоли'): Button[] {
  return ctx.consoleUrl ? [{ text, url: `${ctx.consoleUrl}${path}` }] : []
}

/** Нижний ряд: назад, обновить, меню. */
export function navRow(back: [string, string] | null, refresh: string): Button[] {
  return [...(back ? [cb(`⬅️ ${back[0]}`, back[1])] : []), cb('🔄 Обновить', refresh), ...(back?.[1] === 'm:home' ? [] : [cb('🏠 Меню', 'm:home')])]
}

/** Кнопки по две в ряд. */
export function pairs(buttons: Button[]): Button[][] {
  const rows: Button[][] = []
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2))
  return rows
}

export function keyboard(rows: Button[][]): Record<string, unknown> {
  return { inline_keyboard: rows.filter((r) => r.length) }
}

/** Длительность для людей: «14 мин», «3 ч 5 мин», «2 дн 4 ч». */
export function ago(fromMs: number, toMs: number): string {
  const min = Math.max(0, Math.round((toMs - fromMs) / 60_000))
  if (min < 1) return 'меньше минуты'
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} ч ${min % 60} мин`
  return `${Math.floor(h / 24)} дн ${h % 24} ч`
}

export const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '—' : `${v.toFixed(digits).replace(/\.0+$/, '')}%`)
export const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} с` : `${v} мс`)

/** Текст вида не длиннее лимита Telegram (4096 после разбора HTML): режем по строкам. */
export function fit(lines: string[], max = 3800): string {
  const out: string[] = []
  let len = 0
  for (const line of lines) {
    if (len + line.length + 1 > max) {
      out.push('…')
      break
    }
    out.push(line)
    len += line.length + 1
  }
  return out.join('\n')
}
