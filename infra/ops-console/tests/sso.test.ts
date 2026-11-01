/**
 * Вход через платформу (SSO): консоль — клиент, продукт — IdP. Продукт здесь — локальный
 * HTTP-сервер с теми же эндпоинтами token/introspect, что у backend (`platform/ops-sso`).
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { api, freshApp, login, OWNER } from './helpers'
import { setEnvForTests } from '../server/env'
import { getDb } from '../server/db/client'
import { sessions, users } from '../server/db/schema'
import { resetSsoStateForTests } from '../server/auth/sso'

type App = Awaited<ReturnType<typeof freshApp>>
type Reply = { status: number; body: unknown }

const SECRET = 'sso-client-secret-for-tests'
const PRODUCT = 'https://app.example.test'
const ADMIN = '00000000-0000-4000-8000-0000000000aa'
const operator = { platform_admin_id: ADMIN, console_role: 'operator', email: 'Anna.Ops@Example.test', name: 'Анна' }

const product: {
  calls: Array<{ path: string; body: Record<string, string>; xff: string | undefined }>
  token: Reply
  introspect: Reply
} = {
  calls: [],
  token: { status: 200, body: operator },
  introspect: { status: 200, body: { active: true, ...operator } },
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c: Buffer) => (raw += c.toString()))
  req.on('end', () => {
    const path = req.url ?? ''
    const xff = req.headers['x-forwarded-for']
    product.calls.push({ path, body: JSON.parse(raw || '{}') as Record<string, string>, xff: Array.isArray(xff) ? xff[0] : xff })
    const reply = path.endsWith('/token') ? product.token : path.endsWith('/introspect') ? product.introspect : { status: 404, body: {} }
    res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.body))
  })
})
let productApi = ''

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  productApi = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

let app: App
beforeEach(async () => {
  app = await freshApp()
  setEnvForTests({ ssoProductUrl: PRODUCT, ssoApiUrl: productApi, ssoClientSecret: SECRET })
  resetSsoStateForTests()
  product.calls = []
  product.token = { status: 200, body: operator }
  product.introspect = { status: 200, body: { active: true, ...operator } }
})

function cookie(res: Response, name: string): string | null {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(';')[0]?.trim() ?? ''
    if (pair.startsWith(`${name}=`) && pair.length > name.length + 1) return pair
  }
  return null
}

const rawCookie = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? ''

async function startSso(query = '') {
  const res = await app.request(`/api/auth/sso/start${query}`, { method: 'POST', headers: { 'X-Ops-Csrf': '1' } })
  expect(res.status).toBe(200)
  const { redirectUrl } = (await res.json()) as { redirectUrl: string }
  const relay = new URL(redirectUrl)
  return { res, relay, state: relay.searchParams.get('state') ?? '', stateCookie: cookie(res, 'ops_sso_state') ?? '' }
}

async function ssoLogin(identity: Record<string, string> = operator) {
  product.token = { status: 200, body: identity }
  const { state, stateCookie } = await startSso()
  const res = await app.request(`/api/auth/sso/callback?code=${'c'.repeat(43)}&state=${state}`, { headers: { Cookie: stateCookie } })
  return { res, location: res.headers.get('location'), session: cookie(res, 'ops_session') }
}

const ssoUser = () => getDb().query.users.findFirst({ where: eq(users.platformId, ADMIN) })
/** Сверка «давно не было» — следующий запрос пойдёт в продукт. */
const staleCheck = () => getDb().update(users).set({ ssoCheckedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(users.platformId, ADMIN))
const get = (path: string, session: string) => app.request(`/api${path}`, { headers: { Cookie: session } })

describe('SSO: настройка и старт', () => {
  it('без секрета SSO выключен: /me сообщает это, старт — 503', async () => {
    setEnvForTests({ ssoClientSecret: '' })
    const me = (await (await app.request('/api/auth/me')).json()) as { ssoEnabled: boolean }
    expect(me.ssoEnabled).toBe(false)
    const res = await app.request('/api/auth/sso/start', { method: 'POST', headers: { 'X-Ops-Csrf': '1' } })
    expect(res.status).toBe(503)
  })

  it('старт: страница-посредник продукта, точный redirect_uri, state в узкой httpOnly-cookie', async () => {
    const me = (await (await app.request('/api/auth/me')).json()) as { ssoEnabled: boolean }
    expect(me.ssoEnabled).toBe(true)
    const { res, relay, state } = await startSso()
    expect(relay.origin).toBe(PRODUCT)
    expect(relay.pathname).toBe('/admin/ops-console-sso')
    expect(relay.searchParams.get('redirect_uri')).toBe('http://ops.test/api/auth/sso/callback')
    expect(state.length).toBeGreaterThanOrEqual(24)
    const raw = rawCookie(res, 'ops_sso_state')
    expect(raw).toMatch(/HttpOnly/i)
    expect(raw).toMatch(/SameSite=Lax/i)
    expect(raw).toMatch(/Path=\/api\/auth\/sso/i)
  })

  it('callback с чужим state → отказ, продукт не вызывается', async () => {
    const { stateCookie } = await startSso()
    const res = await app.request(`/api/auth/sso/callback?code=${'c'.repeat(43)}&state=forged-state-value`, { headers: { Cookie: stateCookie } })
    expect(res.headers.get('location')).toBe('/login?sso=state')
    expect(product.calls).toHaveLength(0)
  })

  it('спам callback\'а: после 10 неудач с одного IP продукт больше не вызывается', async () => {
    setEnvForTests({ trustProxy: true })
    const spam = (ip: string) =>
      app.request(`/api/auth/sso/callback?code=${'c'.repeat(43)}&state=aaaaaaaa`, {
        headers: { Cookie: 'ops_sso_state=aaaaaaaa', 'X-Real-IP': ip },
      })
    product.token = { status: 401, body: { message: 'Код недействителен' } }
    for (let i = 0; i < 10; i++) expect((await spam('203.0.113.7')).headers.get('location')).toBe('/login?sso=exchange')
    expect(product.calls).toHaveLength(10)
    // IP браузера уходит продукту: его лимит на /token считается по нему, а не по консоли.
    expect(product.calls[0]?.xff).toBe('203.0.113.7')
    expect((await spam('203.0.113.7')).headers.get('location')).toBe('/login?sso=throttled')
    expect(product.calls).toHaveLength(10)
    // Другой адрес не заперт.
    expect((await spam('198.51.100.9')).headers.get('location')).toBe('/login?sso=exchange')
    setEnvForTests({ trustProxy: false })
  })
})

describe('SSO: вход', () => {
  it('обмен server-side с секретом; учётка по platform_id с ролью из платформы; сессия 12 ч', async () => {
    const { location, session, res } = await ssoLogin()
    expect(location).toBe('/')
    expect(session).toBeTruthy()
    expect(rawCookie(res, 'ops_session')).toMatch(/Max-Age=43200/)
    expect(product.calls[0]?.path).toBe('/api/v1/platform/ops-sso/token')
    expect(product.calls[0]?.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'c'.repeat(43),
      client_secret: SECRET,
      redirect_uri: 'http://ops.test/api/auth/sso/callback',
    })
    const me = (await (await get('/auth/me', session ?? '')).json()) as { user: Record<string, unknown> }
    expect(me.user).toMatchObject({ email: 'anna.ops@example.test', role: 'operator', sso: true, name: 'Анна' })
    const row = await ssoUser()
    expect(row?.passwordHash).toBe('')
    // Паролем SSO-учётку не открыть.
    const pw = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'anna.ops@example.test', password: 'anything-at-all' }),
    })
    expect(pw.status).toBe(401)
  })

  it('повторный вход обновляет роль и имя из платформы', async () => {
    await ssoLogin()
    await ssoLogin({ ...operator, console_role: 'owner', name: 'Анна Петрова' })
    expect(await ssoUser()).toMatchObject({ role: 'owner', name: 'Анна Петрова' })
    const all = await getDb().query.users.findMany({ where: eq(users.platformId, ADMIN) })
    expect(all).toHaveLength(1)
  })

  it('email занят локальной учёткой → отказ «conflict», локальную не трогаем', async () => {
    const { location, session } = await ssoLogin({ ...operator, email: OWNER.email })
    expect(location).toBe('/login?sso=conflict')
    expect(session).toBeNull()
    const local = await getDb().query.users.findFirst({ where: eq(users.email, OWNER.email) })
    expect(local).toMatchObject({ platformId: null, role: 'owner' })
  })

  it('продукт ответил 403 (доступ не выдан/отозван) → «denied»', async () => {
    product.token = { status: 403, body: { message: 'Доступ к Ops-консоли не выдан' } }
    const { state, stateCookie } = await startSso()
    const res = await app.request(`/api/auth/sso/callback?code=${'c'.repeat(43)}&state=${state}`, { headers: { Cookie: stateCookie } })
    expect(res.headers.get('location')).toBe('/login?sso=denied')
  })

  it('кривой ответ продукта → «exchange», учётка не создаётся', async () => {
    const { location } = await ssoLogin({ platform_admin_id: ADMIN, console_role: 'root', email: 'x@y.z', name: 'X' })
    expect(location).toBe('/login?sso=exchange')
    expect(await ssoUser()).toBeUndefined()
  })

  it('заблокированная в консоли SSO-учётка не входит', async () => {
    await ssoLogin()
    await getDb().update(users).set({ disabled: true }).where(eq(users.platformId, ADMIN))
    const { location } = await ssoLogin()
    expect(location).toBe('/login?sso=disabled')
  })
})

describe('SSO: возврат на страницу после входа (?next=)', () => {
  it('/queue: страница живёт в узкой cookie рядом со state, после входа — туда, а не на обзор', async () => {
    product.token = { status: 200, body: operator }
    const { res, state, stateCookie } = await startSso('?next=%2Fqueue')
    const next = cookie(res, 'ops_sso_next')
    expect(next).toBe('ops_sso_next=%2Fqueue')
    expect(rawCookie(res, 'ops_sso_next')).toMatch(/HttpOnly/i)
    expect(rawCookie(res, 'ops_sso_next')).toMatch(/Path=\/api\/auth\/sso/i)
    const cb = await app.request(`/api/auth/sso/callback?code=${'c'.repeat(43)}&state=${state}`, {
      headers: { Cookie: `${stateCookie}; ${next}` },
    })
    expect(cb.headers.get('location')).toBe('/queue')
    expect(cookie(cb, 'ops_session')).toBeTruthy()
  })

  it('короткий адрес очереди: вход начинается и заканчивается на своём хосте, callback — его же', async () => {
    setEnvForTests({ allowedHosts: ['ops.test', 'queue.test'] })
    try {
      product.token = { status: 200, body: operator }
      const host = { Host: 'queue.test' }
      const start = await app.request('/api/auth/sso/start?next=%2Fqueue', { method: 'POST', headers: { 'X-Ops-Csrf': '1', ...host } })
      const relay = new URL(((await start.json()) as { redirectUrl: string }).redirectUrl)
      expect(relay.searchParams.get('redirect_uri')).toBe('http://queue.test/api/auth/sso/callback')
      const cb = await app.request(`/api/auth/sso/callback?code=${'c'.repeat(43)}&state=${relay.searchParams.get('state')}`, {
        headers: { Cookie: `${cookie(start, 'ops_sso_state')}; ${cookie(start, 'ops_sso_next')}`, ...host },
      })
      expect(cb.headers.get('location')).toBe('/queue')
      expect(cookie(cb, 'ops_session')).toBeTruthy()
      // Обмен с тем же redirect_uri, что ушёл в authorize: продукт сверяет его точно.
      expect(product.calls[0]?.body.redirect_uri).toBe('http://queue.test/api/auth/sso/callback')
      // Домен консоли — по-прежнему свой адрес.
      const ops = await app.request('/api/auth/sso/start', { method: 'POST', headers: { 'X-Ops-Csrf': '1', Host: 'ops.test' } })
      const opsRelay = new URL(((await ops.json()) as { redirectUrl: string }).redirectUrl)
      expect(opsRelay.searchParams.get('redirect_uri')).toBe('http://ops.test/api/auth/sso/callback')
    } finally {
      setEnvForTests({ allowedHosts: [] })
    }
  })

  it('короткий адрес очереди: консоль отдаёт только очередь и вход, обход nginx обратным слэшем — тоже 404', async () => {
    const session = await login(app)
    setEnvForTests({ allowedHosts: ['ops.test', 'queue.test'] })
    try {
      const get = (path: string, host: string) => app.request(`http://${host}${path}`, { headers: { Host: host, Cookie: session } })
      expect((await get('/api/overview', 'ops.test')).status).toBe(200)
      expect((await get('/api/overview', 'queue.test')).status).toBe(404)
      // Request (как и Node-сервер) превращает «\» в «/» и сворачивает «..»: nginx пропустил бы путь по префиксу API очереди.
      expect(new URL('http://queue.test/api/oq/v1/..\\..\\overview').pathname).toBe('/api/overview')
      expect((await get('/api/oq/v1/..\\..\\overview', 'ops.test')).status).toBe(200)
      expect((await get('/api/oq/v1/..\\..\\overview', 'queue.test')).status).toBe(404)
      for (const path of ['/tg/password', '/api/health', '/settings', '/', '/queue/assets/x/y']) {
        expect((await get(path, 'queue.test')).status, path).toBe(404)
      }
      expect((await get('/api/auth/me', 'queue.test')).status).toBe(200)
      expect((await get('/queue', 'queue.test')).status).not.toBe(404)
      expect((await get('/api/oq/v1/db/checks', 'queue.test')).status).not.toBe(404)
      // Loopback — агент на хосте и healthcheck — не ограничен.
      expect((await get('/api/health', 'localhost')).status).toBe(200)
    } finally {
      setEnvForTests({ allowedHosts: [] })
    }
  })

  it('чужой адрес в next не принимается: ни cookie, ни переадресации наружу', async () => {
    for (const bad of ['https%3A%2F%2Fevil.example%2F', '%2F%2Fevil.example', '%2Fqueue%2F..%2Fsettings', '%2F']) {
      const { res } = await startSso(`?next=${bad}`)
      expect(cookie(res, 'ops_sso_next')).toBeNull()
    }
    // Подложенная руками cookie с чужим адресом тоже не уводит наружу.
    product.token = { status: 200, body: operator }
    const { state, stateCookie } = await startSso()
    const cb = await app.request(`/api/auth/sso/callback?code=${'c'.repeat(43)}&state=${state}`, {
      headers: { Cookie: `${stateCookie}; ops_sso_next=https%3A%2F%2Fevil.example` },
    })
    expect(cb.headers.get('location')).toBe('/')
  })

  it('отказ входа сохраняет next: после повторного входа владелец всё равно попадёт в очередь', async () => {
    const { res } = await startSso('?next=%2Fqueue')
    const cb = await app.request(`/api/auth/sso/callback?code=${'c'.repeat(43)}&state=forged-state-value`, {
      headers: { Cookie: `${cookie(res, 'ops_sso_state')}; ${cookie(res, 'ops_sso_next')}` },
    })
    expect(cb.headers.get('location')).toBe('/login?sso=state&next=%2Fqueue')
  })
})

describe('SSO: перепроверка живых сессий', () => {
  it('отзыв доступа в платформе закрывает сессии консоли', async () => {
    const { session } = await ssoLogin()
    expect((await get('/overview', session ?? '')).status).toBe(200)
    await staleCheck()
    product.introspect = { status: 200, body: { active: false } }
    expect((await get('/overview', session ?? '')).status).toBe(401)
    const call = product.calls.find((c) => c.path.endsWith('/introspect'))
    expect(call?.body).toMatchObject({ platform_admin_id: ADMIN, client_secret: SECRET })
    const row = await ssoUser()
    const left = await getDb().query.sessions.findMany({ where: eq(sessions.userId, row?.id ?? -1) })
    expect(left).toHaveLength(0)
  })

  it('пока сверка свежая, продукт не вызывается', async () => {
    const { session } = await ssoLogin()
    product.calls = []
    for (let i = 0; i < 3; i++) expect((await get('/overview', session ?? '')).status).toBe(200)
    expect(product.calls).toHaveLength(0)
  })

  it('смена роли в платформе применяется без перелогина', async () => {
    const { session } = await ssoLogin()
    expect((await get('/admin/users', session ?? '')).status).toBe(403)
    await staleCheck()
    product.introspect = { status: 200, body: { active: true, ...operator, console_role: 'owner' } }
    expect((await get('/admin/users', session ?? '')).status).toBe(200)
    expect((await ssoUser())?.role).toBe('owner')
  })

  it('продукт недоступен — сессия живёт, повтор не раньше чем через минуту', async () => {
    const { session } = await ssoLogin()
    await staleCheck()
    product.introspect = { status: 503, body: {} }
    product.calls = []
    expect((await get('/overview', session ?? '')).status).toBe(200)
    expect(product.calls).toHaveLength(1)
    // Даже ответ «отозван» не придёт до конца паузы — продукт не дёргается на каждом запросе.
    product.introspect = { status: 200, body: { active: false } }
    expect((await get('/overview', session ?? '')).status).toBe(200)
    expect(product.calls).toHaveLength(1)
  })

  it('ответ не по контракту — подтвердить доступ нечем: сессии закрываются', async () => {
    const { session } = await ssoLogin()
    await staleCheck()
    product.introspect = { status: 200, body: { active: 'yes' } }
    expect((await get('/overview', session ?? '')).status).toBe(401)
  })

  it('неверный секрет (4xx) — ошибка конфигурации: сессии закрываются', async () => {
    const { session } = await ssoLogin()
    await staleCheck()
    product.introspect = { status: 401, body: { message: 'Неверный client_secret' } }
    expect((await get('/overview', session ?? '')).status).toBe(401)
  })

  it('SSO выключили в консоли — SSO-сессии не действуют, локальная учётка входит', async () => {
    const { session } = await ssoLogin()
    setEnvForTests({ ssoClientSecret: '' })
    expect((await get('/overview', session ?? '')).status).toBe(401)
    const owner = api(app, await login(app))
    expect((await owner.get('/overview')).status).toBe(200)
  })
})

describe('SSO: учётка в консоли', () => {
  it('роль и пароль SSO-учётки в консоли не меняются, блокировка — да', async () => {
    await ssoLogin()
    const owner = api(app, await login(app))
    const list = await owner.get('/admin/users')
    const row = (list.json.users as Array<{ id: number; sso: boolean; email: string }>).find((u) => u.sso)
    expect(row?.email).toBe('anna.ops@example.test')
    expect((await owner.patch(`/admin/users/${row?.id}`, { role: 'viewer' })).status).toBe(409)
    expect((await owner.patch(`/admin/users/${row?.id}`, { password: 'new-password-123' })).status).toBe(409)
    expect((await owner.patch(`/admin/users/${row?.id}`, { disabled: true })).status).toBe(200)
  })

  it('конфликт email снимается сменой email локальной учётки', async () => {
    const owner = api(app, await login(app))
    const created = await owner.post('/admin/users', { email: 'anna.ops@example.test', name: 'Локальная', role: 'viewer', password: 'local-password-1' })
    expect(created.status).toBe(201)
    expect((await ssoLogin()).location).toBe('/login?sso=conflict')
    const list = await owner.get('/admin/users')
    const local = (list.json.users as Array<{ id: number; email: string }>).find((u) => u.email === 'anna.ops@example.test')
    expect((await owner.patch(`/admin/users/${local?.id}`, { email: OWNER.email })).status).toBe(409)
    expect((await owner.patch(`/admin/users/${local?.id}`, { email: 'anna.local@example.test' })).status).toBe(200)
    expect((await ssoLogin()).location).toBe('/')
    const sso = (await owner.get('/admin/users')).json.users as Array<{ id: number; sso: boolean }>
    const ssoRow = sso.find((u) => u.sso)
    expect((await owner.patch(`/admin/users/${ssoRow?.id}`, { email: 'other@example.test' })).status).toBe(409)
  })

  it('последнего локального владельца не снять даже владельцу через платформу', async () => {
    const { session } = await ssoLogin({ ...operator, console_role: 'owner' })
    const ssoOwner = api(app, session ?? '')
    const list = await ssoOwner.get('/admin/users')
    const local = (list.json.users as Array<{ id: number; email: string }>).find((u) => u.email === OWNER.email)
    const res = await ssoOwner.patch(`/admin/users/${local?.id}`, { disabled: true })
    expect(res.status).toBe(409)
    expect(String(res.json.error)).toMatch(/локальный владелец/)
    expect((await ssoOwner.patch(`/admin/users/${local?.id}`, { role: 'operator' })).status).toBe(409)
  })

  it('смена пароля для SSO-учётки — понятный отказ', async () => {
    const { session } = await ssoLogin()
    const me = api(app, session ?? '')
    const res = await me.post('/auth/password', { current: 'whatever-1', next: 'whatever-new-123' })
    expect(res.status).toBe(400)
    expect(String(res.json.error)).toMatch(/через платформу/)
  })
})
