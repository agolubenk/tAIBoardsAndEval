/**
 * Отчёты ИИ-совету: куда уходят (свой приёмник / продукт по связке SSO / никуда), ключ подписи связки,
 * узкое исключение из защиты от внутренних адресов и повторная доставка того же тела.
 */
import { createHmac } from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { api, freshApp, login } from './helpers'
import { setEnvForTests } from '../server/env'
import { getDb } from '../server/db/client'
import { reports } from '../server/db/schema'
import { encryptSecret } from '../server/lib/crypto'
import {
  generateAndSend,
  MAX_DELIVERY_ATTEMPTS,
  redeliverReports,
  REDELIVER_EVERY_MS,
  resolveReceiver,
} from '../server/reports/deliver'
import { PRODUCT_REPORTS_PATH, productReportKey } from '../server/reports/product-link'
import { readReportPeriod, getReportSettings, writeSetting } from '../server/settings/store'
import { runTick } from '../server/scheduler/tick'

const SECRET = 'link-secret-0123456789abcdef0123456789abcdef0123'
const CONSOLE = 'http://ops.test'

const received: Array<{ path: string; headers: IncomingHttpHeaders; body: string }> = []
let reply = 200
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c: Buffer) => (body += c.toString()))
  req.on('end', () => {
    received.push({ path: req.url ?? '', headers: req.headers, body })
    res.writeHead(reply, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply === 200 ? { ok: true } : { message: 'занято' }))
  })
})
let product = ''

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  product = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

beforeEach(async () => {
  await freshApp()
  setEnvForTests({ publicUrl: CONSOLE, ssoProductUrl: 'https://app.example.test', ssoApiUrl: product, ssoClientSecret: SECRET })
  received.length = 0
  reply = 200
})

const signatureOk = (r: (typeof received)[number]) => {
  const ts = String(r.headers['x-ops-timestamp'])
  const key = productReportKey(SECRET, CONSOLE)
  return r.headers['x-ops-signature'] === `sha256=${createHmac('sha256', key).update(`${ts}.${r.body}`).digest('hex')}`
}

describe('ключ связки с продуктом', () => {
  it('совпадает с эталоном продукта (тот же вектор — в apps/backend ops-reports spec)', () => {
    const key = productReportKey('test-sso-secret-0123456789abcdef0123456789abcdef', 'https://ops.example.test')
    expect(key).toBe('11c2ad70fa0c5595574ec9faa122096f97eb6cf8b88809c899b3fc09ceb38145')
    const body = '{"schema":"hrh.ops.report/v1","note":"сводка"}'
    const sig = `sha256=${createHmac('sha256', key).update(`1791408000000.${body}`).digest('hex')}`
    expect(sig).toBe('sha256=7986f4ec186e14a3669c18772a4c2c3118177664f61f8484187ce240c85850c0')
  })
})

describe('куда уходит отчёт', () => {
  it('по умолчанию — включено и в продукт по связке, на внутренний адрес продукта (узкое исключение)', async () => {
    expect((await getReportSettings()).enabled).toBe(true)
    expect((await resolveReceiver()).mode).toBe('product')
    const res = await generateAndSend('daily', 'test')
    expect(res.status).toBe('sent')
    expect(received).toHaveLength(1)
    expect(received[0]?.path).toBe(PRODUCT_REPORTS_PATH)
    expect(signatureOk(received[0]!)).toBe(true)
    const row = await getDb().query.reports.findFirst({ where: eq(reports.id, res.id) })
    expect(row).toMatchObject({ deliveryStatus: 'sent', attempts: 1 })
  })

  it('свой адрес на тот же внутренний хост — запрещён: исключение только для продукта', async () => {
    await writeSetting('reports', { destinationUrl: `${product}/hook`, secretEnc: encryptSecret('manual-secret-value') })
    expect((await resolveReceiver()).mode).toBe('manual')
    const res = await generateAndSend('daily', 'test')
    expect(res.status).toBe('failed')
    expect(res.error).toMatch(/внутренний адрес/)
    expect(received).toHaveLength(0)
  })

  it('адрес без ключа — никуда, в продукт молча не переключаемся', async () => {
    await writeSetting('reports', { destinationUrl: 'https://receiver.example.test/hook' })
    expect((await resolveReceiver()).mode).toBe('none')
    expect((await generateAndSend('daily', 'test')).status).toBe('not_configured')
    expect(received).toHaveLength(0)
  })

  it('без связки (короткий секрет) — никуда', async () => {
    setEnvForTests({ ssoClientSecret: 'short' })
    expect((await resolveReceiver()).mode).toBe('none')
  })
})

describe('повторная доставка', () => {
  it('не дошедший отчёт уходит повторно тем же телом и свежей подписью, не чаще раза в 15 минут', async () => {
    reply = 503
    const first = await generateAndSend('daily', 'test')
    expect(first.status).toBe('failed')
    expect(first.error).toMatch(/HTTP 503: занято/)
    expect(received).toHaveLength(1)

    reply = 200
    const row = await getDb().query.reports.findFirst({ where: eq(reports.id, first.id) })
    const at = row?.lastAttemptAt?.getTime() ?? Date.now()
    expect(await redeliverReports(at + 60_000)).toBe(0)
    expect(received).toHaveLength(1)

    expect(await redeliverReports(at + REDELIVER_EVERY_MS + 1_000)).toBe(1)
    expect(received).toHaveLength(2)
    expect(received[1]?.body).toBe(received[0]?.body)
    expect(signatureOk(received[1]!)).toBe(true)
    const after = await getDb().query.reports.findFirst({ where: eq(reports.id, first.id) })
    expect(after).toMatchObject({ deliveryStatus: 'sent', attempts: 2 })
  })

  it('сломанный ключ своего приёмника: попытка учитывается и не обрывает остальные — повторы конечны', async () => {
    reply = 503
    const first = await generateAndSend('daily', 'test') // в продукт, не дошёл
    await writeSetting('reports', { destinationUrl: 'https://receiver.example.test/hook', secretEnc: 'v1:битый:ключ:x' })
    expect(await resolveReceiver()).toMatchObject({ mode: 'broken' })
    const second = await generateAndSend('daily', 'test')
    expect(second).toMatchObject({ status: 'failed', error: expect.stringMatching(/не расшифровывается/) })

    let t = Date.now() + REDELIVER_EVERY_MS + 1_000
    for (let i = 0; i < 12; i++, t += REDELIVER_EVERY_MS + 1_000) expect(await redeliverReports(t)).toBe(0)
    const rows = await getDb().query.reports.findMany({ where: inArray(reports.id, [first.id, second.id]) })
    // оба дошли до потолка попыток (первый тоже — обход не оборвался на втором), а не повторяются вечно
    expect(rows.map((r) => r.attempts)).toEqual([MAX_DELIVERY_ATTEMPTS, MAX_DELIVERY_ATTEMPTS])
    expect(received).toHaveLength(1) // на сломанный приёмник запросов нет
  })

  it('сохранённый без приёмника уходит, когда приёмник появился; пока его нет — попытки не тратятся', async () => {
    setEnvForTests({ ssoClientSecret: 'short' })
    const res = await generateAndSend('daily', 'test')
    expect(res.status).toBe('not_configured')
    expect(await redeliverReports(Date.now() + REDELIVER_EVERY_MS + 1_000)).toBe(0)
    expect(await getDb().query.reports.findFirst({ where: eq(reports.id, res.id) })).toMatchObject({ attempts: 0 })

    setEnvForTests({ ssoClientSecret: SECRET })
    expect(await redeliverReports()).toBe(1)
    expect(received).toHaveLength(1)
    expect(await getDb().query.reports.findFirst({ where: eq(reports.id, res.id) })).toMatchObject({ deliveryStatus: 'sent', attempts: 1 })
  })

  it('брошенный в pending (процесс упал до отправки) подхватывается сразу', async () => {
    const [row] = await getDb()
      .insert(reports)
      .values({
        period: 'daily',
        periodStart: new Date(Date.now() - 86_400_000),
        periodEnd: new Date(),
        payloadJson: '{"schema":"hrh.ops.report/v1"}',
        deliveryStatus: 'pending',
        createdAt: new Date(),
      })
      .returning({ id: reports.id })
    expect(await redeliverReports()).toBe(1)
    expect(received[0]?.body).toBe('{"schema":"hrh.ops.report/v1"}')
    expect((await getDb().query.reports.findFirst({ where: eq(reports.id, row!.id) }))?.deliveryStatus).toBe('sent')
  })
})

describe('отчёт по расписанию', () => {
  const scheduled = () => getDb().query.reports.findMany({ where: eq(reports.createdBy, 'scheduler') })

  it('перезапуск между записью отчёта и отметкой периода: период не теряется и не собирается дважды', async () => {
    await writeSetting('reports', { hourUtc: 0 })
    // как после перезапуска: отчёт периода уже сохранён, а отметки нет
    await generateAndSend('daily', 'scheduler')
    expect(await readReportPeriod()).toBe('')
    await runTick()
    expect(await scheduled()).toHaveLength(1)
    expect(await readReportPeriod()).toMatch(/^daily:/)
  })

  it('без сохранённого отчёта — собирает и только потом ставит отметку', async () => {
    await writeSetting('reports', { hourUtc: 0 })
    await runTick()
    expect(await scheduled()).toHaveLength(1)
    expect(await readReportPeriod()).toMatch(/^daily:/)
    await runTick() // отметка есть — второй раз не собирает
    expect(await scheduled()).toHaveLength(1)
  })
})

describe('страница настроек', () => {
  it('сломанный ключ своего приёмника — 200 с режимом broken и причиной, а не 500', async () => {
    const app = await freshApp()
    await writeSetting('reports', { destinationUrl: 'https://receiver.example.test/hook', secretEnc: 'v1:битый:ключ:x' })
    const res = await api(app, await login(app)).get('/settings')
    expect(res.status).toBe(200)
    expect(res.json.reports).toMatchObject({ receiver: 'broken', receiverError: expect.stringMatching(/не расшифровывается/) })
  })
})
