/**
 * Отправка отчёта ИИ-совету и ежедневный дайджест в каналы уведомлений.
 *
 * Отчёт сначала сохраняется (pending), потом отправляется; не дошедший повторяется планировщиком
 * (redeliverReports) тем же телом байт в байт со свежей подписью — пока приёмник не примет, не истечёт
 * окно периода или не кончатся попытки. Куда слать — resolveReceiver: свой приёмник владельца, иначе
 * продукт по связке входа через платформу (product-link.ts), иначе отчёт только хранится здесь.
 */
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { reports } from '../db/schema'
import { getEnv } from '../env'
import { decryptSecret } from '../lib/crypto'
import { httpRequest } from '../lib/http'
import { logActivity } from '../activity'
import { broadcast } from '../notify/dispatch'
import { signWebhook } from '../notify/senders'
import { getEgressAllowlist, getGeneralSettings, getReportSettings } from '../settings/store'
import { digestHtml, digestText, reportKeyboard } from './telegram'
import { buildReport } from './build'
import { digestSubject } from './digest'
import { rememberReport } from '../telegram/menu/report'
import { productLinkConfigured, productReceiver } from './product-link'

const DAY = 86_400_000
/** Повтор не чаще раза в 15 минут, не больше 8 попыток, в пределах окна периода. */
export const REDELIVER_EVERY_MS = 15 * 60_000
export const MAX_DELIVERY_ATTEMPTS = 8
const REDELIVER_WINDOW_MS = { daily: DAY, weekly: 7 * DAY } as const

export type ReceiverMode = 'manual' | 'product' | 'none' | 'broken'

type Receiver =
  | { mode: 'manual' | 'product'; url: string; key: string; allowPrivateHosts: string[] }
  | { mode: 'none' }
  | { mode: 'broken'; error: string }

/**
 * Не бросает: сломанный свой приёмник (ключ не расшифровывается — например, сменился ключ шифрования консоли) —
 * режим `broken` с причиной. Исключение отсюда роняло страницу настроек ровно тогда, когда приёмник нужно чинить,
 * а повторную доставку обрывало до учёта попытки — и отчёт повторялся каждые 5 минут без предела.
 */
export async function resolveReceiver(): Promise<Receiver> {
  const cfg = await getReportSettings()
  if (cfg.destinationUrl || cfg.secretEnc) {
    // Свой приёмник владельца — только адрес вместе с секретом; половина настройки — не повод слать в продукт.
    if (!cfg.destinationUrl || !cfg.secretEnc) return { mode: 'none' }
    let key: string
    try {
      key = decryptSecret(cfg.secretEnc)
    } catch {
      return { mode: 'broken', error: 'ключ приёмника не расшифровывается — задайте адрес и ключ заново' }
    }
    return { mode: 'manual', url: cfg.destinationUrl, key, allowPrivateHosts: await getEgressAllowlist() }
  }
  const env = getEnv()
  return productLinkConfigured(env) ? { mode: 'product', ...productReceiver(env) } : { mode: 'none' }
}

export type DeliveryResult = { status: 'not_configured' | 'sent' | 'failed'; error: string | null }

/** Короткая причина отказа приёмника: продукт отвечает JSON с message (подпись / контракт / выключено). */
function refusal(status: number, text: string): string {
  let reason = ''
  try {
    const data = JSON.parse(text) as { message?: unknown }
    if (typeof data.message === 'string') reason = data.message
  } catch {
    /* не JSON — только код */
  }
  return `приёмник ответил HTTP ${status}${reason ? `: ${reason.slice(0, 200)}` : ''}`
}

async function deliverBody(body: string, receiver: Receiver): Promise<DeliveryResult> {
  if (receiver.mode === 'none') return { status: 'not_configured', error: null }
  if (receiver.mode === 'broken') return { status: 'failed', error: receiver.error }
  const ts = String(Date.now())
  try {
    const res = await httpRequest(receiver.url, {
      allowPrivateHosts: receiver.allowPrivateHosts,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ops-Timestamp': ts,
        'X-Ops-Signature': signWebhook(receiver.key, ts, body),
      },
      body,
      timeoutMs: 15_000,
    })
    if (res.status < 200 || res.status >= 300) return { status: 'failed', error: refusal(res.status, res.text) }
    return { status: 'sent', error: null }
  } catch (err) {
    return { status: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }
  }
}

async function attemptDelivery(id: number, body: string, receiver: Receiver): Promise<DeliveryResult> {
  const result = await deliverBody(body, receiver)
  // «Приёмник не задан» — не попытка: отправки не было, и лимит попыток на это не тратится.
  const attempted = result.status !== 'not_configured'
  await getDb()
    .update(reports)
    .set({
      deliveryStatus: result.status,
      deliveryError: result.error,
      ...(attempted ? { attempts: sql`${reports.attempts} + 1`, lastAttemptAt: new Date() } : {}),
    })
    .where(eq(reports.id, id))
  return result
}

const STATUS_LABEL = (r: DeliveryResult) =>
  ({
    not_configured: 'сохранён (приёмник не настроен)',
    sent: 'отправлен ИИ-совету',
    failed: `не доставлен: ${r.error} — повторим автоматически`,
  })[r.status]

export async function generateAndSend(
  period: 'daily' | 'weekly',
  actor: string,
): Promise<{ id: number; status: string; error: string | null }> {
  const report = await buildReport(period)
  const body = JSON.stringify(report)
  const [row] = await getDb()
    .insert(reports)
    .values({
      period,
      periodStart: new Date(report.period.start),
      periodEnd: new Date(report.period.end),
      payloadJson: body,
      deliveryStatus: 'pending',
      createdBy: actor,
      createdAt: new Date(),
    })
    .returning({ id: reports.id })
  if (!row) throw new Error('отчёт не сохранился')
  const delivery = await attemptDelivery(row.id, body, await resolveReceiver())
  await logActivity('report', `Отчёт за ${period === 'daily' ? 'сутки' : 'неделю'} ${STATUS_LABEL(delivery)}`, actor, `/reports/${row.id}`)
  return { id: row.id, status: delivery.status, error: delivery.error }
}

/** Отчёт по расписанию за этот период уже сохранён — консоль перезапустилась между записью отчёта и отметкой периода. */
export async function scheduledReportSince(period: 'daily' | 'weekly', since: Date): Promise<boolean> {
  const row = await getDb().query.reports.findFirst({
    where: and(eq(reports.period, period), eq(reports.createdBy, 'scheduler'), gte(reports.createdAt, since)),
    columns: { id: true },
  })
  return Boolean(row)
}

/**
 * Из полного тика: повторить недоставленные, брошенные в pending и сохранённые без приёмника отчёты (последние —
 * когда приёмник появился). Возвращает число доставленных.
 */
export async function redeliverReports(now = Date.now()): Promise<number> {
  const receiver = await resolveReceiver()
  // Слать некуда — попыток не тратим: отчёты своего окна уйдут, когда приёмник появится.
  if (receiver.mode === 'none') return 0
  const db = getDb()
  const rows = await db.query.reports.findMany({
    where: and(
      inArray(reports.deliveryStatus, ['pending', 'failed', 'not_configured']),
      gte(reports.createdAt, new Date(now - REDELIVER_WINDOW_MS.weekly)),
      lt(reports.attempts, MAX_DELIVERY_ATTEMPTS),
    ),
    orderBy: asc(reports.createdAt),
    limit: 10,
  })
  let delivered = 0
  for (const r of rows) {
    if (now - r.createdAt.getTime() > REDELIVER_WINDOW_MS[r.period]) continue
    if (r.lastAttemptAt && now - r.lastAttemptAt.getTime() < REDELIVER_EVERY_MS) continue
    let result: DeliveryResult
    try {
      result = await attemptDelivery(r.id, r.payloadJson, receiver)
    } catch (err) {
      // Сбой с одним отчётом не останавливает остальные.
      console.warn(`[ops] повторная доставка отчёта #${r.id}:`, err instanceof Error ? err.message : String(err))
      continue
    }
    if (result.status === 'sent') {
      delivered += 1
      await logActivity('report', `Отчёт #${r.id} доставлен ИИ-совету с ${r.attempts + 1}-й попытки`, 'system', `/reports/${r.id}`)
    } else if (r.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) {
      await logActivity(
        'report',
        `Отчёт #${r.id} так и не доставлен после ${MAX_DELIVERY_ATTEMPTS} попыток: ${result.error ?? result.status}`,
        'system',
        `/reports/${r.id}`,
      )
    }
  }
  return delivered
}

export async function sendDailyDigest(): Promise<void> {
  const r = await buildReport('daily')
  rememberReport(r)
  const { timezone } = await getGeneralSettings()
  const html = digestHtml(r, timezone)
  await broadcast(
    'digest',
    {
      subject: digestSubject(r),
      text: digestText(r, timezone),
      html,
      payload: { type: 'digest', report: r },
      // «Подробнее», «Графики», «Срочный отчёт» — там, где нажатие дойдёт до консоли.
      replyMarkup: reportKeyboard(r),
    },
    (ch) => ch.digest,
    (sub) => sub.digest,
  )
  await logActivity('report', 'Отправлен ежедневный отчёт в каналы и подписки')
}
