import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, createHmac } from 'node:crypto'
import { getEnv, setEnvForTests } from '../server/env'
import { resetDbForTests } from '../server/db/client'
import { runMigrations } from '../server/db/migrate'
import { bootstrapOwner } from '../server/auth/session'
import { ensureBuiltinRules } from '../server/alerts/builtin'
import { createApp } from '../server/app'

export const OWNER = { email: 'owner@ops.test', password: 'owner-password-123' }

export async function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), 'ops-console-test-'))
  getEnv()
  setEnvForTests({
    databaseUrl: `file:${join(dir, 'ops.db')}`,
    databaseAuthToken: undefined,
    bootstrapEmail: OWNER.email,
    bootstrapPassword: OWNER.password,
    inProcessScheduler: true,
    isProduction: false,
    publicUrl: 'http://ops.test',
  })
  resetDbForTests()
  await runMigrations()
  await bootstrapOwner()
  await ensureBuiltinRules()
  return createApp()
}

type App = ReturnType<typeof createApp>

export async function login(app: App, email = OWNER.email, password = OWNER.password): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`)
  const cookie = res.headers.get('set-cookie') ?? ''
  return cookie.split(';')[0] ?? ''
}

export function api(app: App, cookie: string) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { Cookie: cookie, 'X-Ops-Csrf': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any> }
  }
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b: unknown = {}) => call('POST', p, b),
    put: (p: string, b: unknown) => call('PUT', p, b),
    patch: (p: string, b: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  }
}

let lastTs = 0

/** Подписанный запрос агента — тот же алгоритм, что в agent/hrh-ops-agent.py (path — для событий деплоя). */
export function signedAgentRequest(agentId: string, secret: string, body: unknown, opts: { ts?: number; path?: string; raw?: string } = {}) {
  // Метка строго растёт и с явным ts тоже: иначе следующий запрос в ту же миллисекунду — «повтор» (409).
  const ts = opts.ts ?? Math.max(Date.now(), lastTs + 1)
  lastTs = Math.max(lastTs, ts)
  const raw = opts.raw ?? JSON.stringify(body)
  const hash = createHash('sha256').update(raw).digest('hex')
  const sig = createHmac('sha256', secret)
    .update(`${ts}.POST.${opts.path ?? '/api/agent/report'}.${hash}`)
    .digest('hex')
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ops-Agent': agentId,
      'X-Ops-Timestamp': String(ts),
      'X-Ops-Signature': `sha256=${sig}`,
    },
    body: raw,
  }
}

export function report(containers: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    agentVersion: '1.0.0',
    hostname: 'test-host',
    os: 'Linux test',
    intervalSec: 15,
    cpu: { pct: 12, load1: 0.4, cores: 4 },
    memory: { totalMb: 8000, usedMb: 3000 },
    disks: [{ mount: '/', totalGb: 100, usedGb: 40 }],
    containers,
    ...extra,
  }
}
