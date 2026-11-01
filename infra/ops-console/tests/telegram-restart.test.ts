/**
 * Перезапуск контейнера из бота: «Перезапустить» в карточке контейнера → причина → у контейнера с
 * данными — точное имя → команда в очереди агента тем же путём, что из консоли. Права на каждом шаге,
 * отказы без команды, срок диалога и команды (10 минут), повторы без дублей. Telegram API перехвачен
 * на уровне httpRequest, вебхук вызывается как Telegram.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { eq, like } from 'drizzle-orm'
import { api, freshApp, login, report, signedAgentRequest } from './helpers'
import { getDb } from '../server/db/client'
import { activity, channels, commands, settings, users } from '../server/db/schema'
import { encryptJson, hashPassword } from '../server/lib/crypto'
import { setEnvForTests } from '../server/env'
import { signInitData } from '../server/telegram/initdata'
import * as http from '../server/lib/http'
import { setTelegramSyncForTests } from '../server/telegram/actions'
import { expireStaleCommands } from '../server/containers/commands'
import { pruneTelegramTables } from '../server/telegram/bot'
import { requestRestart } from '../server/containers/restart'

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const TG = 5001
const PW = 'correct-horse-battery'
const AGENT = 'contabo-prod'
const ANNA = { email: 'anna@ops.test', password: 'anna-password-123' }

type Call = { method: string; body: Record<string, any> }
type InlineButton = { text: string; callback_data?: string }
let app: Awaited<ReturnType<typeof freshApp>>
let calls: Call[]
let spy: MockInstance<typeof http.httpRequest>
let secret = ''
let agentSecret = ''
let updateId = 1
let msgId = 1000

beforeEach(async () => {
  setTelegramSyncForTests(true)
  app = await freshApp()
  setEnvForTests({ publicUrl: 'https://ops.example.com', publicUrlExplicit: true })
  calls = []
  spy = vi.spyOn(http, 'httpRequest').mockImplementation(async (url, opts) => {
    const method = url.split('/').at(-1) ?? ''
    const body: Record<string, any> = JSON.parse(String(opts?.body ?? '{}'))
    calls.push({ method, body })
    let result: unknown = true
    if (method === 'getMe') result = { id: 123456789, username: 'ops_test_bot' }
    if (method === 'getWebhookInfo') result = { url: '' }
    if (method === 'setWebhook') secret = body.secret_token
    if (method === 'sendMessage') result = { message_id: msgId++ }
    return { status: 200, ok: true, text: JSON.stringify({ ok: true, result }), latencyMs: 1 }
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
/** Сообщение в личке; text === undefined — не текст (стикер, фото). */
const pm = (text: string | undefined) => ({
  message: { message_id: msgId++, chat: { id: TG, type: 'private' }, from: { id: TG, is_bot: false }, ...(text === undefined ? {} : { text }) },
})
const press = (data: string, chat = TG) => ({
  callback_query: { id: `cq${updateId}`, from: { id: TG }, message: { message_id: 77, chat: { id: chat, type: chat === TG ? 'private' : 'supergroup' } }, data },
})
const last = (method: string) => calls.filter((c) => c.method === method).at(-1)
const inline = (c: Call | undefined): InlineButton[] => ((c?.body.reply_markup?.inline_keyboard ?? []) as InlineButton[][]).flat()
const buttons = (c: Call | undefined): string[] => inline(c).map((b) => b.callback_data ?? '').filter(Boolean)
const findButton = (c: Call | undefined, prefix: string): string => {
  const found = buttons(c).find((b) => b.startsWith(prefix))
  if (!found) throw new Error(`нет кнопки ${prefix}: ${JSON.stringify(buttons(c))}`)
  return found
}
const allCommands = () => getDb().query.commands.findMany({ orderBy: commands.id })

const ctr = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  image: `${name}:latest`,
  state: 'running',
  health: 'healthy',
  status: 'Up 1 hour',
  restartCount: 0,
  composeService: name,
  restartPolicy: 'unless-stopped',
  ...over,
})
const HEALTHY = [ctr('backend-1'), ctr('postgres')]

/** Отчёт агента хоста — ответом приходят команды, которые он выполнит (тот же путь, что у консоли). */
async function agentReport(containers = HEALTHY): Promise<string[]> {
  const res = await app.request('/api/agent/report', signedAgentRequest(AGENT, agentSecret, report(containers)))
  expect(res.status).toBe(200)
  return ((await res.json()) as { commands: Array<{ target: string }> }).commands.map((c) => c.target)
}

/** Хост с агентом (контейнеры из его отчёта), бот с паролем, подписка Анны с подтверждённым паролем. */
async function setup(role: 'operator' | 'viewer' = 'operator') {
  const owner = api(app, await login(app))
  const created = await owner.post('/admin/agents', { id: AGENT, name: 'Contabo · prod', environment: 'production' })
  expect(created.status).toBe(201)
  agentSecret = created.json.secret
  await agentReport()
  await owner.put('/telegram/bot', { token: TOKEN })
  await owner.put('/telegram/bot/password', { password: PW })
  await getDb().insert(users).values({ email: ANNA.email, name: 'Anna', role, passwordHash: await hashPassword(ANNA.password), createdAt: new Date() })
  const anna = api(app, await login(app, ANNA.email, ANNA.password))
  const link = await anna.post('/telegram/me/link')
  await hook(pm(`/start ${String(link.json.url).split('start=')[1]}`))
  const code = /<code>(\d{3}) (\d{3})<\/code>/.exec(String(last('sendMessage')?.body.text))!
  await anna.post('/telegram/me/confirm', { code: code[1]! + code[2]! })
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: TG }) }, TOKEN)
  await app.request('/api/telegram/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, password: PW }) })
  calls.splice(0)
  return { owner }
}

/** Меню → Серверы → хост → Контейнеры → карточка контейнера (как нажимает человек). */
async function openCard(name: string): Promise<Call> {
  await hook(press('m:hs'))
  await hook(press(findButton(last('editMessageText'), 'm:h:')))
  await hook(press(findButton(last('editMessageText'), 'm:hc:')))
  const btn = inline(last('editMessageText')).find((b) => b.text.endsWith(` ${name}`))?.callback_data
  expect(btn).toMatch(/^m:k:\d+x[0-9a-f]{6}$/)
  calls.splice(0)
  await hook(press(btn!))
  return last('editMessageText')!
}

describe('перезапуск контейнера из бота', () => {
  it('контейнер без данных: причина спрошена → команда в очереди агента тем же путём, что из консоли → журнал с каналом', async () => {
    const { owner } = await setup()
    // Контейнер упал: алерт после двух отчётов, критичный — с инцидентом.
    const down = [ctr('backend-1', { state: 'exited', health: 'none', exitCode: 1, status: 'Exited (1)' }), ctr('postgres')]
    await agentReport(down)
    await agentReport(down)
    const alert = (await owner.get('/alerts?status=firing')).json.alerts.find((a: any) => a.object === 'backend-1 · Contabo · prod')
    expect(alert?.incidentId).toBeTruthy()
    calls.splice(0)
    const card = await openCard('backend-1')
    expect(card.body.text).toContain('<b>backend-1</b> — остановлен')
    expect(card.body.text).toContain('код выхода 1')
    calls.splice(0)
    await hook(press(findButton(card, 'm:kr:')))
    const ask = last('sendMessage')!
    expect(ask.body).toMatchObject({ chat_id: String(TG), parse_mode: 'HTML' })
    expect(ask.body.text).toContain('Напишите причину')
    expect(buttons(ask)).toEqual([expect.stringMatching(/^m:kx:[A-Za-z0-9_-]{8}$/)])
    // Кнопка сама ничего не перезапускает.
    expect(await allCommands()).toHaveLength(0)

    calls.splice(0)
    await hook(pm('unhealthy после деплоя'))
    const [cmd] = await allCommands()
    expect(cmd).toMatchObject({ agentId: AGENT, type: 'restart', target: 'backend-1', status: 'pending', reason: 'unhealthy после деплоя', requestedBy: ANNA.email })
    const done = last('sendMessage')!
    expect(done.body.text).toContain(`Команда #${cmd!.id} в очереди`)
    expect(findButton(done, 'm:k:')).toMatch(/^m:k:\d+x[0-9a-f]{6}$/)
    // Журнал: кто, когда, причина и канал. Хронология инцидента — с тем же каналом.
    const logged = await getDb().query.activity.findMany({ where: like(activity.message, 'Запрошен перезапуск%') })
    expect(logged).toEqual([
      expect.objectContaining({
        kind: 'action',
        actor: ANNA.email,
        message: 'Запрошен перезапуск backend-1 на Contabo · prod (из Telegram): unhealthy после деплоя',
        route: `/infrastructure/${AGENT}`,
        createdAt: expect.any(Date),
      }),
    ])
    const timeline = (await owner.get(`/incidents/${alert.incidentId}`)).json.events.map((x: any) => x.message)
    expect(timeline).toContain('Перезапуск backend-1 запрошен (из Telegram): unhealthy после деплоя')
    // Агент забирает её следующим отчётом — как команду из консоли.
    expect(await agentReport(down)).toEqual(['backend-1'])
    // Карточка показывает, что команда выполняется, и не предлагает второй перезапуск.
    calls.splice(0)
    await hook(press(findButton(done, 'm:k:')))
    const status = last('editMessageText')!
    expect(status.body.text).toContain('выполняется на сервере')
    expect(buttons(status).some((b) => b.startsWith('m:kr:'))).toBe(false)
    // Из консоли — тот же журнал без пометки канала.
    expect((await owner.post(`/infra/agents/${AGENT}/containers/postgres/restart`, { reason: 'проверка из консоли', confirmName: 'postgres' })).status).toBe(202)
    expect((await getDb().query.activity.findMany({ where: like(activity.message, 'Запрошен перезапуск postgres%') })).map((x) => [x.actor, x.message])).toEqual([
      ['owner@ops.test', 'Запрошен перезапуск postgres на Contabo · prod: проверка из консоли'],
    ])
  })

  it('контейнер с данными (postgres): без точного имени перезапуска нет — неверное имя → отказ, команда не создана', async () => {
    await setup()
    const card = await openCard('postgres')
    expect(card.body.text).toContain('Хранит данные')
    calls.splice(0)
    await hook(press(findButton(card, 'm:kr:')))
    expect(last('sendMessage')!.body.text).toContain('хранит данные')
    await hook(pm('медленные запросы после миграции'))
    expect(last('sendMessage')!.body.text).toContain('отправьте его имя полностью: <code>postgres</code>')
    expect(await allCommands()).toHaveLength(0)

    calls.splice(0)
    await hook(pm('Postgres'))
    const refusal = last('sendMessage')!
    expect(refusal.body.text).toContain('Имя не совпало')
    expect(refusal.body.text).toContain('команда не создана')
    expect(await allCommands()).toHaveLength(0)
    // Диалог окончен: точное имя после отказа уже ничего не подтверждает.
    calls.splice(0)
    await hook(pm('postgres'))
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
    expect(await allCommands()).toHaveLength(0)

    // «Начать заново» — снова причина и имя; с точным именем команда есть.
    await hook(press(findButton(refusal, 'm:kr:')))
    await hook(pm('медленные запросы после миграции'))
    await hook(pm('postgres'))
    expect(await allCommands()).toMatchObject([{ target: 'postgres', reason: 'медленные запросы после миграции', requestedBy: ANNA.email, status: 'pending' }])
  })

  it('наблюдатель: кнопки нет, нажатие — отказ без команды; роль проверяется заново на шаге с причиной', async () => {
    await setup('viewer')
    const card = await openCard('backend-1')
    expect(buttons(card).some((b) => b.startsWith('m:kr:'))).toBe(false)
    const key = findButton(card, 'm:k:').slice('m:k:'.length)
    calls.splice(0)
    await hook(press(`m:kr:${key}`))
    expect(last('answerCallbackQuery')?.body).toMatchObject({ show_alert: true, text: expect.stringContaining('роль оператора') })
    expect(last('sendMessage')).toBeUndefined()
    await hook(pm('хочу перезапустить'))
    expect(await allCommands()).toHaveLength(0)

    // Оператора понизили посреди диалога — шаг с причиной отказывает, команды нет.
    await getDb().update(users).set({ role: 'operator' }).where(eq(users.email, ANNA.email))
    await hook(press(`m:kr:${key}`))
    expect(last('sendMessage')!.body.text).toContain('Напишите причину')
    await getDb().update(users).set({ role: 'viewer' }).where(eq(users.email, ANNA.email))
    calls.splice(0)
    await hook(pm('утечка памяти'))
    expect(last('sendMessage')!.body.text).toContain('нужна роль оператора')
    expect(await allCommands()).toHaveLength(0)
    // Общая функция не пускает наблюдателя сама — не только кнопка бота и роут консоли.
    await expect(requestRestart({ email: 'viewer@ops.test', role: 'viewer' }, { agentId: AGENT, container: 'backend-1', reason: 'проверка' })).rejects.toMatchObject({
      kind: 'forbidden',
      status: 403,
    })
  })

  it('без причины команда не создаётся: пусто, пробелы, короче 3 символов, не текст — правило общее с консолью', async () => {
    const { owner } = await setup()
    const card = await openCard('backend-1')
    await hook(press(findButton(card, 'm:kr:')))
    for (const bad of ['   ', '', 'ok', undefined]) {
      calls.splice(0)
      await hook(pm(bad))
      const reply = last('sendMessage')!
      expect(reply.body.text).toContain('Причина обязательна')
      expect(buttons(reply)).toEqual([expect.stringMatching(/^m:kx:/)])
    }
    expect(await allCommands()).toHaveLength(0)
    // Диалог жив: нормальная причина после отказов — команда.
    await hook(pm('зависли воркеры'))
    expect(await allCommands()).toMatchObject([{ target: 'backend-1', reason: 'зависли воркеры' }])
    // Консоль — то же правило из той же функции.
    const res = await owner.post(`/infra/agents/${AGENT}/containers/postgres/restart`, { reason: '  ', confirmName: 'postgres' })
    expect(res.status).toBe(400)
    expect(res.json.error).toContain('Причина обязательна')
  })

  it('диалог и неподтверждённая команда истекают через 10 минут; двойное нажатие и повтор апдейта не создают дубль', async () => {
    await setup()
    const restart = findButton(await openCard('backend-1'), 'm:kr:')
    calls.splice(0)
    await hook(press(restart))
    await hook(press(restart))
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1)
    expect(last('answerCallbackQuery')?.body.text).toContain('Уже жду причину')

    // Диалогу больше 10 минут — причина уже не принимается.
    const row = (await getDb().query.settings.findFirst({ where: like(settings.key, 'tg-dialog:%') }))!
    await getDb()
      .update(settings)
      .set({ value: JSON.stringify({ ...JSON.parse(row.value), expiresAt: Date.now() - 1 }) })
      .where(eq(settings.key, row.key))
    calls.splice(0)
    await hook(pm('поздняя причина'))
    expect(last('sendMessage')!.body.text).toContain('Время на перезапуск вышло')
    expect(await allCommands()).toHaveLength(0)

    // Ретрай вебхука с тем же update_id — одна команда; повторное «Перезапустить» — отказ, не дубль.
    await hook(press(restart))
    const reason = { update_id: 9_000_001, ...pm('плановый перезапуск') }
    await hook(reason)
    await hook(reason)
    expect(await allCommands()).toHaveLength(1)
    calls.splice(0)
    await hook(press(restart))
    expect(last('answerCallbackQuery')?.body).toMatchObject({ show_alert: true, text: expect.stringContaining('уже в очереди') })
    expect(last('sendMessage')).toBeUndefined()
    expect(await allCommands()).toHaveLength(1)

    // Агент не забрал команду за 10 минут — истекла, как из консоли; новый перезапуск снова возможен.
    await getDb().update(commands).set({ requestedAt: new Date(Date.now() - 11 * 60_000) })
    await expireStaleCommands()
    expect((await allCommands())[0]?.status).toBe('expired')
    await hook(press(restart))
    await hook(pm('после истечения'))
    expect((await allCommands()).map((c) => c.status)).toEqual(['expired', 'pending'])
  })

  it('в группе кнопки нет и диалог не начинается; «Отменить» — только свой текущий диалог; кнопки ≤ 64 байт', async () => {
    await setup()
    await getDb()
      .insert(channels)
      .values({ kind: 'telegram', name: 'дежурные', configJson: JSON.stringify({ chatId: '-100777' }), secretEnc: encryptJson({ botToken: TOKEN }), createdAt: new Date() })
    const restart = findButton(await openCard('backend-1'), 'm:kr:')
    const key = restart.slice('m:kr:'.length)
    calls.splice(0)
    await hook(press(`m:k:${key}`, -100777))
    expect(last('editMessageText')!.body.text).toContain('backend-1')
    expect(buttons(last('editMessageText')).some((b) => b.startsWith('m:kr:'))).toBe(false)
    calls.splice(0)
    await hook(press(restart, -100777))
    expect(last('answerCallbackQuery')?.body).toMatchObject({ show_alert: true, text: expect.stringContaining('личном чате') })
    expect(last('sendMessage')).toBeUndefined()

    // Кнопка «Отменить» прошлого диалога не трогает текущий; своя — отменяет, команды нет.
    await hook(press(restart))
    const first = findButton(last('sendMessage'), 'm:kx:')
    await hook(press(findButton(await openCard('postgres'), 'm:kr:')))
    const second = findButton(last('sendMessage'), 'm:kx:')
    calls.splice(0)
    await hook(press(first))
    expect(last('answerCallbackQuery')?.body.text).toContain('от прошлого диалога')
    await hook(press(second))
    expect(last('answerCallbackQuery')?.body.text).toBe('Отменено')
    expect(last('editMessageText')!.body.text).toContain('отменён — команда не создана')
    calls.splice(0)
    await hook(pm('после отмены'))
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
    expect(await allCommands()).toHaveLength(0)
    for (const d of [restart, first, second, `m:k:${key}`]) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64)
  })

  it('вопрос о причине не дошёл (сбой Telegram) — диалога нет: следующее сообщение не станет причиной', async () => {
    await setup()
    const restart = findButton(await openCard('backend-1'), 'm:kr:')
    calls.splice(0)
    spy.mockImplementationOnce(async () => ({
      status: 400,
      ok: false,
      text: JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
      latencyMs: 1,
    }))
    await hook(press(restart))
    expect(last('answerCallbackQuery')?.body.text).toContain('Не получилось')
    expect(await getDb().query.settings.findFirst({ where: like(settings.key, 'tg-dialog:%') })).toBeUndefined()
    calls.splice(0)
    await hook(pm('случайное сообщение'))
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
    expect(await allCommands()).toHaveLength(0)
  })

  it('брошенный диалог чистит тик', async () => {
    await setup()
    await hook(press(findButton(await openCard('backend-1'), 'm:kr:')))
    const dialogs = () => getDb().query.settings.findMany({ where: like(settings.key, 'tg-dialog:%') })
    expect(await dialogs()).toHaveLength(1)
    await pruneTelegramTables()
    expect(await dialogs()).toHaveLength(1)
    await getDb()
      .update(settings)
      .set({ updatedAt: new Date(Date.now() - 11 * 60_000) })
      .where(like(settings.key, 'tg-dialog:%'))
    await pruneTelegramTables()
    expect(await dialogs()).toHaveLength(0)
  })
})
