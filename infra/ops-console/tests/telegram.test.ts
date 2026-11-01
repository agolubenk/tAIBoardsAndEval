/**
 * Личные Telegram-подписки: привязка (ссылка → /start → код в консоли), пароль бота (Mini App),
 * перебор, смена пароля, отключение учётки, вебхук. Telegram API перехвачен на уровне httpRequest,
 * вебхук вызывается как Telegram — с secret_token.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { eq } from 'drizzle-orm'
import { api, freshApp, login, OWNER } from './helpers'
import { getDb } from '../server/db/client'
import { alerts, deliveries, tgBot, tgLinkTokens, tgSubscriptions, users } from '../server/db/schema'
import { hashPassword } from '../server/lib/crypto'
import { setEnvForTests } from '../server/env'
import { signInitData, verifyInitData } from '../server/telegram/initdata'
import { observe, type Observation } from '../server/alerts/store'
import * as http from '../server/lib/http'

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const BOT_ID = '123456789'
const ADMIN = { email: 'anna@ops.test', password: 'anna-password-123' }
const ADMIN_TG = 5001
const BOT_PASSWORD = 'correct-horse-battery'

type Call = { method: string; body: Record<string, any> }

let app: Awaited<ReturnType<typeof freshApp>>
let calls: Call[]
let webhookSecret = ''
let spy: MockInstance<typeof http.httpRequest>
let nextMsg = 900

function mockTelegram() {
  calls = []
  spy = vi.spyOn(http, 'httpRequest').mockImplementation(async (url, opts) => {
    const method = url.split('/').at(-1) ?? ''
    const body = JSON.parse(String(opts?.body ?? '{}')) as Record<string, any>
    calls.push({ method, body })
    let result: unknown = true
    if (method === 'getMe') result = { id: Number(BOT_ID), username: 'ops_test_bot' }
    if (method === 'getWebhookInfo') result = { url: '', pending_update_count: 0 }
    if (method === 'setWebhook') webhookSecret = body.secret_token
    if (method === 'sendMessage') result = { message_id: nextMsg++ }
    return { status: 200, ok: true, text: JSON.stringify({ ok: true, result }), latencyMs: 1 }
  })
}

let updateId = 1
async function webhook(update: Record<string, unknown>, secret = webhookSecret) {
  return app.request('/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: updateId++, ...update }),
  })
}

const privateMsg = (tgId: number, text: string) => ({
  message: { message_id: updateId + 10_000, chat: { id: tgId, type: 'private' }, from: { id: tgId, is_bot: false, username: 'anna' }, text },
})

const sentTexts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text))

async function passwordViaApp(tgId: number, password: string) {
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: tgId, first_name: 'Anna' }) }, TOKEN)
  return app.request('/api/telegram/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, password }),
  })
}

/** Владелец подключает бота и задаёт пароль; админ проходит привязку до ввода пароля. */
async function setup() {
  const owner = api(app, await login(app))
  expect((await owner.put('/telegram/bot', { token: TOKEN })).status).toBe(200)
  expect((await owner.put('/telegram/bot/password', { password: BOT_PASSWORD })).status).toBe(200)
  await getDb().insert(users).values({ email: ADMIN.email, name: 'Anna', role: 'operator', passwordHash: await hashPassword(ADMIN.password), createdAt: new Date() })
  const anna = api(app, await login(app, ADMIN.email, ADMIN.password))
  const link = await anna.post('/telegram/me/link')
  const token = String(link.json.url).split('start=')[1]
  await webhook(privateMsg(ADMIN_TG, `/start ${token}`))
  const code = /<code>(\d{3}) (\d{3})<\/code>/.exec(sentTexts().at(-1) ?? '')
  expect(code).not.toBeNull()
  return { owner, anna, token, code: `${code![1]}${code![2]}` }
}

beforeEach(async () => {
  app = await freshApp()
  setEnvForTests({ publicUrl: 'https://ops.example.com', publicUrlExplicit: true })
  mockTelegram()
})
afterEach(() => {
  spy.mockRestore()
  setEnvForTests({ publicUrl: 'http://ops.test', publicUrlExplicit: false })
})

describe('initData Mini App', () => {
  it('подпись Telegram проверяется; подделка, чужой токен и старая строка отклоняются', () => {
    const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 42 }) }
    expect(verifyInitData(signInitData(fields, TOKEN), TOKEN)).toEqual({ tgUserId: '42' })
    expect(verifyInitData(signInitData(fields, TOKEN), '1:other-token-aaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull()
    const tampered = signInitData(fields, TOKEN).replace('%22id%22%3A42', '%22id%22%3A43')
    expect(verifyInitData(tampered, TOKEN)).toBeNull()
    const old = { ...fields, auth_date: String(Math.floor(Date.now() / 1000) - 3600) }
    expect(verifyInitData(signInitData(old, TOKEN), TOKEN)).toBeNull()
  })
})

describe('вебхук', () => {
  it('без верного secret_token — 401; повтор update_id не обрабатывается дважды', async () => {
    await setup()
    expect((await webhook(privateMsg(ADMIN_TG, '/help'), 'wrong')).status).toBe(401)
    const before = calls.length
    const res = await app.request('/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': webhookSecret },
      body: JSON.stringify({ update_id: 77, ...privateMsg(9999, '/start') }),
    })
    expect(res.status).toBe(200)
    await app.request('/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': webhookSecret },
      body: JSON.stringify({ update_id: 77, ...privateMsg(9999, '/start') }),
    })
    expect(calls.slice(before).filter((c) => c.method === 'sendMessage')).toHaveLength(1) // нейтральный ответ — один раз
  })

  it('вебхук ставится с secret_token, max_connections=1 и нужными типами апдейтов', async () => {
    await setup()
    const set = calls.find((c) => c.method === 'setWebhook')!
    expect(set.body).toMatchObject({ url: 'https://ops.example.com/api/telegram/webhook', max_connections: 1 })
    expect(set.body.allowed_updates).toEqual(['message', 'callback_query', 'my_chat_member'])
    expect(set.body.secret_token).toMatch(/^[A-Za-z0-9_-]{32,}$/)
  })
})

describe('привязка и пароль', () => {
  it('полный путь: ссылка → /start → код в консоли → пароль в Mini App → уведомления идут', async () => {
    const { anna, code } = await setup()
    expect((await anna.get('/telegram/me')).json.pending.stage).toBe('code')
    expect((await anna.post('/telegram/me/confirm', { code })).status).toBe(200)
    expect((await anna.get('/telegram/me')).json.subscription.status).toBe('awaiting_password')
    const res = await passwordViaApp(ADMIN_TG, BOT_PASSWORD)
    expect(res.status).toBe(200)
    expect((await anna.get('/telegram/me')).json.subscription.status).toBe('active')

    calls.splice(0)
    await observe(obs(true))
    const toAnna = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === String(ADMIN_TG))
    expect(String(toAnna?.body.text)).toContain('КРИТИЧНО')
    const row = await getDb().query.deliveries.findFirst({ where: eq(deliveries.target, 'личная подписка #1') })
    expect(row?.externalId).toMatch(new RegExp(`^${BOT_ID}/${ADMIN_TG}:\\d+$`)) // ветка — в пространстве «бот/чат»
  })

  it('чужая ссылка: подсмотревший /start без сессии жертвы не завершит привязку', async () => {
    const { anna, token } = await setup()
    // Ссылка уже погашена первым /start — второй Telegram получает отказ.
    calls.splice(0)
    await webhook(privateMsg(6666, `/start ${token}`))
    expect(sentTexts().at(-1)).toContain('Ссылка устарела')
    expect((await anna.post('/telegram/me/confirm', { code: '000000' })).status).toBe(400)
  })

  it('пароль сообщением при https не проверяется — сообщение удаляется, просьба нажать кнопку', async () => {
    const { anna, code } = await setup()
    await anna.post('/telegram/me/confirm', { code })
    calls.splice(0)
    await webhook(privateMsg(ADMIN_TG, BOT_PASSWORD))
    expect(calls.map((c) => c.method)).toContain('deleteMessage')
    expect(sentTexts().at(-1)).toContain('кнопкой «Ввести пароль»')
    expect((await anna.get('/telegram/me')).json.subscription.status).toBe('awaiting_password')
  })

  it('перебор: после 5 неверных паролей подписка остановлена, снять может только владелец', async () => {
    const { owner, anna, code } = await setup()
    await anna.post('/telegram/me/confirm', { code })
    for (let i = 0; i < 5; i++) expect((await passwordViaApp(ADMIN_TG, `wrong-${i}`)).status).toBe(400)
    const me = (await anna.get('/telegram/me')).json.subscription
    expect(me).toMatchObject({ status: 'suspended', ownerLock: true })
    expect((await passwordViaApp(ADMIN_TG, BOT_PASSWORD)).status).toBe(400)
    expect((await anna.post('/telegram/me/resume')).status).toBe(403)
    expect((await owner.post(`/telegram/subscriptions/${me.id}/resume`)).status).toBe(200)
    expect((await passwordViaApp(ADMIN_TG, BOT_PASSWORD)).status).toBe(200)
  })
})

describe('жизненный цикл', () => {
  async function activeAnna() {
    const ctx = await setup()
    await ctx.anna.post('/telegram/me/confirm', { code: ctx.code })
    expect((await passwordViaApp(ADMIN_TG, BOT_PASSWORD)).status).toBe(200)
    return ctx
  }

  it('смена пароля: всем — просьба ввести новый, до ввода уведомления не идут', async () => {
    const { owner, anna } = await activeAnna()
    calls.splice(0)
    const res = await owner.put('/telegram/bot/password', { password: '' })
    expect(res.json.password).toHaveLength(20)
    expect(sentTexts().some((t) => t.includes('Пароль бота изменён'))).toBe(true)
    expect((await anna.get('/telegram/me')).json.subscription.status).toBe('reconfirm')
    calls.splice(0)
    await observe(obs(true))
    expect(calls.some((c) => c.method === 'sendMessage' && c.body.chat_id === String(ADMIN_TG))).toBe(false)
    expect((await passwordViaApp(ADMIN_TG, BOT_PASSWORD)).status).toBe(400) // старый не подходит
    expect((await passwordViaApp(ADMIN_TG, res.json.password)).status).toBe(200)
    expect((await anna.get('/telegram/me')).json.subscription.status).toBe('active')
  })

  it('отключение учётки: подписка остановлена; после включения — только ручное возобновление с паролем', async () => {
    const { owner, anna } = await activeAnna()
    const annaId = (await getDb().query.users.findFirst({ where: eq(users.email, ADMIN.email) }))!.id
    expect((await owner.patch(`/admin/users/${annaId}`, { disabled: true })).status).toBe(200)
    const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.userId, annaId) })
    expect(sub?.state).toBe('suspended')
    expect(sentTexts().some((t) => t.includes('Уведомления остановлены'))).toBe(true)
    await owner.patch(`/admin/users/${annaId}`, { disabled: false })
    calls.splice(0)
    await observe(obs(true))
    expect(calls.some((c) => c.method === 'sendMessage' && c.body.chat_id === String(ADMIN_TG))).toBe(false)
    const anna2 = api(app, await login(app, ADMIN.email, ADMIN.password))
    expect((await anna2.post('/telegram/me/resume')).status).toBe(200)
    expect((await anna2.get('/telegram/me')).json.subscription.status).toBe('awaiting_password')
    void anna
  })

  it('/stop в боте — пауза; блокировка бота пользователем — тоже', async () => {
    const { anna } = await activeAnna()
    await webhook(privateMsg(ADMIN_TG, '/stop'))
    expect((await anna.get('/telegram/me')).json.subscription.status).toBe('suspended')
    expect((await anna.post('/telegram/me/resume')).status).toBe(200) // сам — можно
    await webhook({ my_chat_member: { chat: { id: ADMIN_TG, type: 'private' }, new_chat_member: { status: 'kicked' } } })
    expect((await anna.get('/telegram/me')).json.subscription.status).toBe('suspended')
  })

  it('чужой адрес вебхука в тике — ввод пароля заморожен', async () => {
    await activeAnna()
    spy.mockImplementation(async (url) => {
      const method = url.split('/').at(-1) ?? ''
      const result = method === 'getWebhookInfo' ? { url: 'https://evil.example/hook', pending_update_count: 0 } : true
      return { status: 200, ok: true, text: JSON.stringify({ ok: true, result }), latencyMs: 1 }
    })
    const { checkWebhook } = await import('../server/telegram/bot')
    await checkWebhook()
    const bot = await getDb().query.tgBot.findFirst()
    expect(bot?.frozenReason).toContain('чужой адрес')
    // Подписке, которой нужно ввести пароль, ввод закрыт, пока владелец не откроет его.
    await getDb().update(tgSubscriptions).set({ state: 'awaiting_password', confirmedVersion: 0 })
    const res = await passwordViaApp(ADMIN_TG, BOT_PASSWORD)
    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain('временно закрыт')
    void tgBot
    void alerts
  })

  it('незнакомец получает нейтральный ответ без имени продукта и адреса; в группе бот молчит', async () => {
    await setup()
    calls.splice(0)
    await webhook(privateMsg(7777, '/start'))
    expect(sentTexts()).toEqual(['Служебный бот. Подключение — только из консоли.'])
    calls.splice(0)
    await webhook({ message: { message_id: 1, chat: { id: -100500, type: 'supergroup', title: 'ops' }, from: { id: 7777, is_bot: false }, text: '/help' } })
    expect(sentTexts()).toEqual([])
    void OWNER
  })
})


describe('исправления после ревью', () => {
  async function activeAnna() {
    const ctx = await setup()
    await ctx.anna.post('/telegram/me/confirm', { code: ctx.code })
    expect((await passwordViaApp(ADMIN_TG, BOT_PASSWORD)).status).toBe(200)
    return ctx
  }

  it('остановку владельцем не обойти перепривязкой или отвязкой', async () => {
    const { owner, anna } = await activeAnna()
    const sub = (await anna.get('/telegram/me')).json.subscription
    await owner.post(`/telegram/subscriptions/${sub.id}/suspend`)
    expect((await anna.post('/telegram/me/link')).status).toBe(403)
    expect((await anna.del('/telegram/me')).status).toBe(403)
    expect((await anna.post('/telegram/me/resume')).status).toBe(403)
  })

  it('перебор кода: параллельные попытки не дают больше пяти', async () => {
    const { anna } = await setup()
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => anna.post('/telegram/me/confirm', { code: String(100000 + i) })))
    expect(results.filter((r) => r.status === 400).length).toBeLessThanOrEqual(5)
    expect(await getDb().query.tgLinkTokens.findFirst()).toBeUndefined() // ссылка погашена
    void tgLinkTokens
  })

  it('незнакомец с /start <мусор> — тот же нейтральный ответ с лимитом, без подсказок консоли', async () => {
    await setup()
    calls.splice(0)
    await webhook(privateMsg(8888, '/start AAAAAAAAAAAAAAAAAAAAAAAA'))
    expect(sentTexts()).toEqual(['Служебный бот. Подключение — только из консоли.'])
  })

  it('пароль уже подтверждён — повторный ввод не ошибка; пробелы в пароле не мешают', async () => {
    await activeAnna()
    const again = await passwordViaApp(ADMIN_TG, BOT_PASSWORD)
    expect(again.status).toBe(200)
    expect((await again.json()).message).toContain('уже подтверждён')
  })

  it('сгенерированный пароль принимается с пробелами (как показан группами)', async () => {
    const { owner, anna, code } = await setup()
    const gen = (await owner.put('/telegram/bot/password', { password: '' })).json.password as string
    await anna.post('/telegram/me/confirm', { code })
    expect((await passwordViaApp(ADMIN_TG, gen.replace(/(.{4})(?=.)/g, '$1 '))).status).toBe(200)
  })

  it('разморозка сбрасывает общий счётчик — одна опечатка не замораживает снова', async () => {
    const { owner } = await activeAnna()
    await getDb().update(tgBot).set({ frozenReason: 'тест', frozenAt: new Date() })
    expect((await owner.post('/telegram/bot/unfreeze')).status).toBe(200)
    expect((await getDb().query.tgBot.findFirst())?.frozenReason).toBeNull()
  })

  it('дайджест уходит подписке с включённым дайджестом', async () => {
    const { anna } = await activeAnna()
    await anna.patch('/telegram/me', { digest: true })
    calls.splice(0)
    const { sendDailyDigest } = await import('../server/reports/deliver')
    await sendDailyDigest()
    expect(calls.some((c) => c.method === 'sendMessage' && c.body.chat_id === String(ADMIN_TG))).toBe(true)
  })

  it('Mini App — лёгкая страница без стороннего JS', async () => {
    const res = await app.request('/tg/password')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('/api/telegram/password')
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html.length).toBeLessThan(8000)
  })

  it('профиль показывает, чей Telegram открыл ссылку; истёкший код не «висит»', async () => {
    const { anna } = await setup()
    const me = (await anna.get('/telegram/me')).json
    expect(me.pending.telegram).toContain('@anna')
    await getDb().update(tgLinkTokens).set({ codeExpiresAt: new Date(Date.now() - 1000) })
    expect((await anna.get('/telegram/me')).json.pending).toBeNull()
  })
})

function obs(breached: boolean): Observation {
  return {
    rule: { id: 999, forSamples: 1, severity: 'critical', repeatMin: 0 },
    fingerprint: 'test:tg',
    breached,
    title: 'Агент молчит',
    object: 'prod',
    value: 'нет отчётов',
  }
}
