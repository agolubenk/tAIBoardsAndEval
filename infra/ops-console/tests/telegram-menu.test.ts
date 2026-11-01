/**
 * Меню бота: /menu и /start, переходы правкой одного сообщения (список → карточка → назад),
 * действия из карточек (оператор), разделы подробного отчёта, права в группе, лимит нажатий,
 * длина callback_data.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { eq } from 'drizzle-orm'
import { api, freshApp, login } from './helpers'
import { getDb } from '../server/db/client'
import { agents, alerts, channels, containers, incidents, monitors, users } from '../server/db/schema'
import { encryptJson, hashPassword } from '../server/lib/crypto'
import { setEnvForTests } from '../server/env'
import { signInitData } from '../server/telegram/initdata'
import { observe } from '../server/alerts/store'
import * as http from '../server/lib/http'
import { setTelegramSyncForTests } from '../server/telegram/actions'
import { resetReportCacheForTests } from '../server/telegram/menu/report'
import { resetSnapshotCacheForTests } from '../server/reports/charts'

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const TG = 5001
const PW = 'correct-horse-battery'

type Call = { method: string; body: Record<string, any> }
let app: Awaited<ReturnType<typeof freshApp>>
let calls: Call[]
let spy: MockInstance<typeof http.httpRequest>
let secret = ''
let updateId = 1
let msgId = 1000

beforeEach(async () => {
  setTelegramSyncForTests(true)
  resetReportCacheForTests()
  resetSnapshotCacheForTests()
  app = await freshApp()
  setEnvForTests({ publicUrl: 'https://ops.example.com', publicUrlExplicit: true })
  calls = []
  spy = vi.spyOn(http, 'httpRequest').mockImplementation(async (url, opts) => {
    const method = url.split('/').at(-1) ?? ''
    const raw = opts?.body
    const body: Record<string, any> = Buffer.isBuffer(raw) ? {} : JSON.parse(String(raw ?? '{}'))
    calls.push({ method, body })
    let result: unknown = true
    if (method === 'getMe') result = { id: 123456789, username: 'ops_test_bot' }
    if (method === 'getWebhookInfo') result = { url: '' }
    if (method === 'setWebhook') secret = body.secret_token
    if (method === 'sendMessage') result = { message_id: msgId++ }
    if (method === 'sendMediaGroup') result = [{ message_id: msgId++ }]
    return { status: 200, ok: true, text: JSON.stringify({ ok: true, result }), latencyMs: 3 }
  })
})
afterEach(() => {
  spy.mockRestore()
  setEnvForTests({ publicUrl: 'http://ops.test', publicUrlExplicit: false })
})

const hook = (update: Record<string, unknown>) =>
  app.request('/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: updateId++, ...update }),
  })
const pm = (tg: number, text: string) => ({ message: { message_id: 1, chat: { id: tg, type: 'private' }, from: { id: tg, is_bot: false }, text } })
const press = (tg: number, data: string, chat = tg) => ({
  callback_query: { id: `cq${updateId}`, from: { id: tg }, message: { message_id: 77, chat: { id: chat, type: chat === tg ? 'private' : 'supergroup' } }, data },
})
const last = (method: string) => calls.filter((c) => c.method === method).at(-1)
const buttons = (c: Call | undefined): string[] =>
  ((c?.body.reply_markup?.inline_keyboard ?? []) as Array<Array<{ callback_data?: string }>>).flat().map((b) => b.callback_data ?? '').filter(Boolean)

async function setupActive(role: 'operator' | 'viewer' = 'operator') {
  const owner = api(app, await login(app))
  await owner.put('/telegram/bot', { token: TOKEN })
  await owner.put('/telegram/bot/password', { password: PW })
  await getDb().insert(users).values({ email: 'anna@ops.test', name: 'Anna', role, passwordHash: await hashPassword('anna-password-123'), createdAt: new Date() })
  const anna = api(app, await login(app, 'anna@ops.test', 'anna-password-123'))
  const link = await anna.post('/telegram/me/link')
  await hook(pm(TG, `/start ${String(link.json.url).split('start=')[1]}`))
  const code = /<code>(\d{3}) (\d{3})<\/code>/.exec(String(last('sendMessage')?.body.text))!
  await anna.post('/telegram/me/confirm', { code: code[1]! + code[2]! })
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: TG }) }, TOKEN)
  await app.request('/api/telegram/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, password: PW }) })
  calls.splice(0)
  return { owner, anna }
}

async function seed() {
  const now = Date.now()
  await getDb()
    .insert(agents)
    .values({
      id: 'contabo-prod',
      name: 'Contabo · prod',
      environment: 'production',
      secretEnc: 'x',
      secretHint: 'x',
      lastSeenAt: new Date(now - 5000),
      lastSnapshotJson: JSON.stringify({ osName: 'Ubuntu 24.04', cpu: { pct: 42, cores: 4, load1: 1.2 }, memory: { totalMb: 16384, usedMb: 8192 }, disks: [{ mount: '/', totalGb: 100, usedGb: 80, inodePct: 9 }] }),
      createdAt: new Date(),
    })
  const base = { agentId: 'contabo-prod', image: 'hr/backend', health: 'none', restartCount: 0, updatedAt: new Date() }
  await getDb()
    .insert(containers)
    .values([
      { ...base, name: 'backend-1', state: 'running', memMb: 500, memLimitMb: 1024 },
      { ...base, name: 'worker-1', state: 'restarting', restartPolicy: 'always' },
    ])
  await getDb().insert(monitors).values({ name: 'API health', url: 'https://app.example.com/health', lastOk: true, lastCheckedAt: new Date(), createdAt: new Date() })
  await observe({ rule: { id: 1, forSamples: 1, severity: 'critical', repeatMin: 0 }, fingerprint: 'loop', breached: true, title: 'Restart loop', object: 'worker-1 · Contabo · prod', value: '18 за 10 мин', route: '/infrastructure/contabo-prod' })
  calls.splice(0)
}

describe('меню бота', () => {
  it('/menu и /start — меню кнопками; переходы правят то же сообщение; карточка алерта с действием', async () => {
    await setupActive()
    await seed()
    await hook(pm(TG, '/menu'))
    const home = last('sendMessage')!
    expect(home.body.text).toContain('🔴 <b>Горит 1</b> · критичных 1 · без ответственного 1')
    // Что горит — прямо на главной, кнопкой к карточке.
    expect(buttons(home).some((b) => /^m:a:\d+$/.test(b))).toBe(true)
    expect(buttons(home)).toEqual(expect.arrayContaining(['m:al', 'm:in', 'm:hs', 'm:ms', 'm:dp', 'm:tl', 'rep:now', 'rep:charts', 'm:home']))
    calls.splice(0)
    await hook(pm(TG, '/start'))
    expect(buttons(last('sendMessage'))).toContain('m:al')

    calls.splice(0)
    await hook(press(TG, 'm:al'))
    const list = last('editMessageText')!
    expect(list.body).toMatchObject({ chat_id: String(TG), message_id: 77, parse_mode: 'HTML' })
    const alertBtn = buttons(list).find((b) => /^m:a:\d+$/.test(b))!
    expect(alertBtn).toBeTruthy()
    calls.splice(0)
    await hook(press(TG, alertBtn))
    const card = last('editMessageText')!
    expect(card.body.text).toContain('Restart loop')
    const ack = buttons(card).find((b) => b.startsWith('m:aa:'))!
    expect(ack).toBeTruthy()
    expect(buttons(card)).toContain('m:al')
    calls.splice(0)
    await hook(press(TG, ack))
    expect(last('answerCallbackQuery')?.body.text).toContain('Взято в работу')
    const after = last('editMessageText')!
    expect(after.body.text).toContain('✋ В работе: anna@ops.test')
    expect(buttons(after).some((b) => b.startsWith('m:aa:'))).toBe(false)
    const id = Number(ack.split(':')[2])
    expect((await getDb().query.alerts.findFirst({ where: eq(alerts.id, id) }))?.acknowledgedBy).toBe('anna@ops.test')
  })

  it('серверы → хост → контейнеры; проверки → карточка → «Проверить сейчас»; инцидент → «Взять себе»', async () => {
    await setupActive()
    await seed()
    await hook(press(TG, 'm:hs'))
    const hostBtn = buttons(last('editMessageText')).find((b) => /^m:h:\d+x[0-9a-f]{4}$/.test(b))!
    await hook(press(TG, hostBtn))
    const host = last('editMessageText')!
    expect(host.body.text).toMatch(/CPU <b>42%<\/b>/)
    expect(host.body.text).toContain('worker-1')
    await hook(press(TG, buttons(host).find((b) => b.startsWith('m:hc:'))!))
    expect(last('editMessageText')!.body.text).toContain('backend-1')

    await hook(press(TG, 'm:ms'))
    const monBtn = buttons(last('editMessageText')).find((b) => /^m:c:\d+$/.test(b))!
    await hook(press(TG, monBtn))
    const mon = last('editMessageText')!
    expect(mon.body.text).toContain('API health')
    calls.splice(0)
    await hook(press(TG, buttons(mon).find((b) => b.startsWith('m:cc:'))!))
    expect(last('answerCallbackQuery')?.body.text).toBe('Проверяю…')
    expect(last('editMessageText')!.body.text).toMatch(/Последняя проверка .*HTTP 200/)
    calls.splice(0)
    await hook(press(TG, buttons(mon).find((b) => b.startsWith('m:cc:'))!))
    expect(last('answerCallbackQuery')?.body.text).toContain('подождите 15 секунд')

    const inc = (await getDb().query.incidents.findMany())[0]!
    await hook(press(TG, `m:i:${inc.id}`))
    const take = buttons(last('editMessageText')).find((b) => b.startsWith('m:ia:'))!
    await hook(press(TG, take))
    expect((await getDb().query.incidents.findFirst({ where: eq(incidents.id, inc.id) }))?.assignee).toBe('anna@ops.test')
    expect(last('editMessageText')!.body.text).toContain('Ответственный: <b>anna@ops.test</b>')
  })

  it('«Больше информации» — разделы в одном сообщении; «Весь отчёт» — прежней выдачей', async () => {
    await setupActive()
    await seed()
    const endMin = Math.floor(Date.now() / 60_000)
    await hook(press(TG, `rep:more:${endMin}`))
    const sec = last('sendMessage')!
    expect(sec.body.reply_parameters).toMatchObject({ message_id: 77 })
    expect(sec.body.text).toContain('подробный отчёт')
    expect(buttons(sec)).toEqual(expect.arrayContaining([`rs:av:${endMin}`, `rs:hst:${endMin}`, `rs:all:${endMin}`]))
    calls.splice(0)
    await hook(press(TG, `rs:hst:${endMin}`))
    const hst = last('editMessageText')!
    expect(hst.body.text).toContain('🖥 <b>Серверы</b>')
    expect(buttons(hst)).toContain(`rs:sum:${endMin}`)
    calls.splice(0)
    await hook(press(TG, `rs:all:${endMin}`))
    expect(calls.filter((c) => c.method === 'sendMessage').length).toBeGreaterThan(0)
  })

  it('наблюдатель: смотрит, но без кнопок действий; в группе без канала — отказ; незнакомцу — отказ', async () => {
    await setupActive('viewer')
    await seed()
    const alert = (await getDb().query.alerts.findMany())[0]!
    await hook(press(TG, `m:a:${alert.id}`))
    expect(buttons(last('editMessageText')).some((b) => b.startsWith('m:aa:'))).toBe(false)
    calls.splice(0)
    await hook(press(TG, `m:aa:${alert.id}`))
    expect(last('answerCallbackQuery')?.body).toMatchObject({ show_alert: true, text: expect.stringContaining('оператора') })
    calls.splice(0)
    await hook(press(TG, 'm:al', -100777))
    expect(last('answerCallbackQuery')?.body.show_alert).toBe(true)
    expect(last('editMessageText')).toBeUndefined()
    calls.splice(0)
    await hook(press(4242, 'm:home'))
    expect(last('answerCallbackQuery')?.body.show_alert).toBe(true)
    calls.splice(0)
    await hook({ message: { message_id: 2, chat: { id: -100777, type: 'supergroup' }, from: { id: 4242, is_bot: false }, text: '/menu' } })
    expect(calls.length).toBe(0)
  })

  it('оператор в группе-канале консоли — меню работает; лимит нажатий; «не изменилось» — без дубля', async () => {
    await setupActive()
    await seed()
    await getDb()
      .insert(channels)
      .values({ kind: 'telegram', name: 'дежурные', configJson: JSON.stringify({ chatId: '-100777' }), secretEnc: encryptJson({ botToken: TOKEN }), createdAt: new Date() })
    await hook({ message: { message_id: 2, chat: { id: -100777, type: 'supergroup' }, from: { id: TG, is_bot: false }, text: '/menu@ops_test_bot' } })
    expect(buttons(last('sendMessage'))).toContain('m:al')
    // «message is not modified» — не ошибка, нового сообщения нет.
    calls.splice(0)
    spy.mockImplementationOnce(async (url, opts) => {
      calls.push({ method: url.split('/').at(-1) ?? '', body: JSON.parse(String(opts?.body ?? '{}')) })
      return { status: 200, ok: true, text: JSON.stringify({ ok: true, result: true }), latencyMs: 1 }
    })
    spy.mockImplementationOnce(async (url, opts) => {
      calls.push({ method: url.split('/').at(-1) ?? '', body: JSON.parse(String(opts?.body ?? '{}')) })
      return { status: 400, ok: false, text: JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }), latencyMs: 1 }
    })
    await hook(press(TG, 'm:home', -100777))
    expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'editMessageText'])
    // Лимит: 60 нажатий в минуту на человека.
    for (let i = 0; i < 60; i++) await hook(press(TG, 'm:tl'))
    calls.splice(0)
    await hook(press(TG, 'm:tl'))
    expect(last('answerCallbackQuery')?.body.text).toContain('Слишком быстро')
  })

  it('все кнопки всех экранов — callback_data не длиннее 64 байт; несуществующий объект — понятный экран', async () => {
    await setupActive()
    await seed()
    await getDb().update(agents).set({ id: 'x'.repeat(64) }).where(eq(agents.id, 'contabo-prod'))
    const datas = new Set<string>()
    const visit = async (data: string) => {
      calls.splice(0)
      await hook(press(TG, data))
      for (const c of calls) for (const b of buttons(c)) datas.add(b)
    }
    await hook(pm(TG, '/menu'))
    for (const b of buttons(last('sendMessage'))) datas.add(b)
    for (const d of ['m:home', 'm:al', 'm:ar', 'm:in', 'm:hs', 'm:ms', 'm:dp', 'm:tl']) await visit(d)
    for (const d of [...datas].filter((x) => /^m:(a|i|h|c):[\dxa-f]+$/.test(x))) await visit(d)
    expect(datas.size).toBeGreaterThan(15)
    expect([...datas].some((d) => /^m:hg:\d+x[0-9a-f]{4}$/.test(d))).toBe(true)
    for (const d of datas) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64)
    await visit('m:a:99999999')
    expect(last('editMessageText')!.body.text).toContain('Объект не найден')
  })

  it('старая кнопка: закрытый инцидент не берётся; ключ удалённого сервера не открывает другой; «Подробнее» под пуш-карточкой', async () => {
    await setupActive()
    await seed()
    const inc = (await getDb().query.incidents.findMany())[0]!
    await getDb().update(incidents).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(incidents.id, inc.id))
    calls.splice(0)
    await hook(press(TG, `m:ia:${inc.id}`))
    expect(last('answerCallbackQuery')?.body.text).toBe('Инцидент уже закрыт.')
    expect((await getDb().query.incidents.findFirst({ where: eq(incidents.id, inc.id) }))?.assignee).toBeNull()
    // Ключ хоста с чужим хвостом (rowid переиспользован) — «не найден», а не чужой сервер.
    await hook(press(TG, 'm:h:1x0000'))
    expect(last('editMessageText')!.body.text).toContain('Объект не найден')
    // Пуш-карточка алерта в личной подписке — кнопка «Подробнее» открывает карточку меню новым сообщением.
    await observe({ rule: { id: 1, forSamples: 1, severity: 'critical', repeatMin: 0 }, fingerprint: 'cpu', breached: true, title: 'CPU', object: 'Contabo · prod', value: '97%', route: '/infrastructure/contabo-prod' })
    const push = calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === String(TG)).at(-1)!
    const details = buttons(push).find((b) => b.startsWith('mo:a:'))!
    expect(details).toBeTruthy()
    calls.splice(0)
    await hook(press(TG, details))
    const card = last('sendMessage')!
    expect(card.body.text).toContain('CPU')
    expect(buttons(card).some((b) => /^m:h:\d+x[0-9a-f]{4}$/.test(b))).toBe(true)
  })

  it('лимиты: новое сообщение меню в группе — раз в 10 с; отчёты за периоды не из кэша — не больше 6 за 5 минут', async () => {
    await setupActive()
    await seed()
    await getDb()
      .insert(channels)
      .values({ kind: 'telegram', name: 'дежурные', configJson: JSON.stringify({ chatId: '-100777' }), secretEnc: encryptJson({ botToken: TOKEN }), createdAt: new Date() })
    await hook(press(TG, 'mo:home', -100777))
    expect(buttons(last('sendMessage'))).toContain('m:al')
    calls.splice(0)
    await hook(press(TG, 'mo:home', -100777))
    expect(last('answerCallbackQuery')?.body.text).toContain('Только что открывали')
    expect(last('sendMessage')).toBeUndefined()
    const nowMin = Math.floor(Date.now() / 60_000)
    for (let i = 1; i <= 6; i++) await hook(press(TG, `rs:av:${nowMin - i * 60}`))
    calls.splice(0)
    await hook(press(TG, `rs:av:${nowMin - 7 * 60}`))
    expect(last('answerCallbackQuery')?.body.text).toContain('Слишком много отчётов')
    // Раздел уже построенного периода — из кэша, без лимита построений.
    calls.splice(0)
    await hook(press(TG, `rs:inc:${nowMin - 60}`))
    expect(last('editMessageText')?.body.text).toContain('Инциденты')
  })
})
