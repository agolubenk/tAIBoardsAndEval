/** Подключение агента одноразовым кодом: один раз, 15 минут, новый секрет, лимит попыток, установщик. */
import { beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { api, freshApp, login } from './helpers'
import { getDb } from '../server/db/client'
import { agentEnrollments, agents } from '../server/db/schema'
import { setEnvForTests } from '../server/env'
import { decryptSecret } from '../server/lib/crypto'

let app: Awaited<ReturnType<typeof freshApp>>
beforeEach(async () => {
  app = await freshApp()
})

const enroll = (code: string, ip = '203.0.113.7') =>
  app.request('/api/agent/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: JSON.stringify({ code }) })

describe('подключение агента по коду', () => {
  it('без https-адреса — отказ; код меняется на env с новым секретом ровно один раз', async () => {
    const owner = api(app, await login(app))
    await owner.post('/admin/agents', { id: 'web-1', name: 'web-1' })
    // publicUrl теста — http://ops.test (не localhost): установка по коду недоступна.
    expect((await owner.post('/admin/agents/web-1/enroll')).status).toBe(409)
    setEnvForTests({ publicUrl: 'https://ops.example.com', trustProxy: true })
    const r = await owner.post('/admin/agents/web-1/enroll')
    expect(r.status).toBe(200)
    const code = /OPS_ENROLL_CODE=([A-Za-z0-9_-]{32}) bash$/.exec(r.json.command)![1]!
    expect(r.json.command).toMatch(/^curl -fsSL https:\/\/ops\.example\.com\/agent\/install\.sh \| sudo OPS_ENROLL_CODE=/)
    const before = (await getDb().query.agents.findFirst({ where: eq(agents.id, 'web-1') }))!.secretEnc
    const res = await enroll(code)
    expect(res.status).toBe(200)
    const env = await res.text()
    const secret = /OPS_AGENT_SECRET=(hrhops_\S+)/.exec(env)![1]!
    expect(env).toContain('OPS_CONSOLE_URL=https://ops.example.com')
    const after = (await getDb().query.agents.findFirst({ where: eq(agents.id, 'web-1') }))!
    expect(after.secretEnc).not.toBe(before)
    expect(decryptSecret(after.secretEnc)).toBe(secret)
    // Повтор того же кода — отказ.
    expect((await enroll(code)).status).toBe(403)
    // В базе — только хэш кода.
    const rows = await getDb().query.agentEnrollments.findMany()
    expect(rows.every((x) => !x.codeHash.includes(code))).toBe(true)
    expect(rows[0]?.usedFromIp).toBe('203.0.113.7')
    setEnvForTests({ publicUrl: 'http://ops.test', trustProxy: false })
  })

  it('истёкший код не работает; новый код отменяет прежний; подбор упирается в лимит', async () => {
    setEnvForTests({ publicUrl: 'https://ops.example.com', trustProxy: true })
    const owner = api(app, await login(app))
    await owner.post('/admin/agents', { id: 'db-1', name: 'db-1' })
    const first = /OPS_ENROLL_CODE=(\S+) bash/.exec((await owner.post('/admin/agents/db-1/enroll')).json.command)![1]!
    const second = /OPS_ENROLL_CODE=(\S+) bash/.exec((await owner.post('/admin/agents/db-1/enroll')).json.command)![1]!
    expect((await enroll(first)).status).toBe(403)
    await getDb().update(agentEnrollments).set({ expiresAt: new Date(Date.now() - 1000) })
    expect((await enroll(second)).status).toBe(403)
    for (let i = 0; i < 10; i++) await enroll('A'.repeat(32), '198.51.100.9')
    expect((await enroll('B'.repeat(32), '198.51.100.9')).status).toBe(429)
    expect((await enroll('not-a-code', '192.0.2.1')).status).toBe(403)
    setEnvForTests({ publicUrl: 'http://ops.test', trustProxy: false })
  })

  it('установщик: валидный bash, вшиты адрес и суммы файлов; файлы — только из списка', async () => {
    setEnvForTests({ publicUrl: 'https://ops.example.com' })
    const script = await (await app.request('/agent/install.sh')).text()
    expect(script).toContain("CONSOLE_URL='https://ops.example.com'")
    expect(script).toMatch(/[0-9a-f]{64} {2}hrh-ops-agent\.py/)
    expect(script).toContain("--proto '=https'")
    const dir = mkdtempSync(join(tmpdir(), 'ops-install-'))
    writeFileSync(join(dir, 'install.sh'), script)
    execFileSync('bash', ['-n', join(dir, 'install.sh')])
    expect((await app.request('/agent/files/hrh_ops_collect.py')).status).toBe(200)
    expect((await app.request('/agent/files/hrh_ops_edge.py')).status).toBe(200)
    expect(script).toMatch(/[0-9a-f]{64} {2}hrh_ops_edge\.py/)
    for (const f of ['hrh_ops_vpn.py', 'hrh-ops-vpnd.py', 'hrh-ops-vpn.service']) {
      expect((await app.request(`/agent/files/${f}`)).status).toBe(200)
      expect(script).toContain(`  ${f}`)
    }
    expect(script).toContain('[[ "$vpn_was" == masked* ]] || install -m 644 "$tmp/hrh-ops-vpn.service"')
    expect((await app.request('/agent/files/..%2F.env')).status).toBe(404)
    expect((await app.request('/agent/files/hrh-ops-agent.env.example')).status).toBe(404)
    setEnvForTests({ publicUrl: 'http://ops.test' })
    expect((await app.request('/agent/install.sh')).status).toBe(503)
  })
})
