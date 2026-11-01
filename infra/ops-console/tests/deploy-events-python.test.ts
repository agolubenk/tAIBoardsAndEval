/**
 * Кросс-языковая проверка подписи: помощник infra/scripts/prod/ops-deploy-event.py (python3, его зовёт
 * contabo-deploy.sh) против настоящего сервера консоли по HTTP. Чужая подпись, чужой агент и просроченное
 * время — 401, событие не записано. Плюс гарантии помощника: тишина в выводе, stdin не читается.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve, type ServerType } from '@hono/node-server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { api, freshApp, login } from './helpers'
import { getDb } from '../server/db/client'
import { deployProgress } from '../server/db/schema'

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/prod/ops-deploy-event.py')
const hasPython = spawnSync('python3', ['--version']).status === 0
const SHA = '9c1e2d3f4a5b6c7d8e9f00112233445566778899'

let app: Awaited<ReturnType<typeof freshApp>>
let server: ServerType
let consoleUrl = ''
let secret = ''
const dir = mkdtempSync(join(tmpdir(), 'ops-deploy-event-'))

interface Run {
  code: number | null
  stdout: string
  stderr: string
  ms: number
}

/** Помощник как его зовёт библиотека деплоя; stdin остаётся открытым — читай он его, завис бы до дедлайна. */
function runHelper(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const start = Date.now()
    const child = spawn('python3', ['-I', HELPER, ...args])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - start }))
  })
}

function envFile(name: string, lines: Record<string, string>): string {
  const path = join(dir, name)
  writeFileSync(path, `# тест\n${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 })
  return path
}

const eventArgs = (t0: number, seq: number, type: string, extra: string[] = []) => [
  '--event',
  type,
  '--seq',
  String(seq),
  '--sha',
  SHA,
  '--started',
  String(t0),
  '--now',
  String(t0 + seq),
  '--log',
  `p preflight running ${t0} -\np preflight ok ${t0 + 4} 0\nc spa running ${t0 + 5} - https://app.example.test/\nc - ok ${t0 + 6} 0 https://app.example.test/`,
  ...extra,
]

const cards = (t0: number) => getDb().select().from(deployProgress).where(eq(deployProgress.deployId, `${SHA}-${t0}`))

beforeAll(async () => {
  if (!hasPython) return
  app = await freshApp()
  const owner = api(app, await login(app))
  secret = (await owner.post('/admin/agents', { id: 'prod', name: 'prod' })).json.secret
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      consoleUrl = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
})

describe.skipIf(!hasPython)('ops-deploy-event.py ↔ консоль', () => {
  it('подпись помощника принимается: событие и итог записаны, вывод пуст, stdin не читается', async () => {
    const env = envFile('ok.env', { OPS_CONSOLE_URL: consoleUrl, OPS_AGENT_ID: 'prod', OPS_AGENT_SECRET: `"${secret}"` })
    const t0 = Math.floor(Date.now() / 1000) - 30
    const first = await runHelper([...eventArgs(t0, 1, 'deploy_start'), '--env-file', env])
    expect(first).toMatchObject({ code: 0, stdout: '', stderr: '' })
    expect(first.ms).toBeLessThan(2500)
    const done = await runHelper([...eventArgs(t0, 2, 'deploy_done', ['--rc', '0']), '--env-file', env])
    expect(done.code).toBe(0)
    const [row] = await cards(t0)
    expect(row).toMatchObject({ agentId: 'prod', sha: SHA, status: 'success', rc: 0, lastSeq: 2 })
    const summary = JSON.parse(row!.summaryJson)
    expect(summary.phases).toEqual([{ key: 'preflight', status: 'ok', startedAt: t0, endedAt: t0 + 4, rc: 0 }])
    expect(summary.checks).toEqual([{ key: 'spa', url: 'https://app.example.test/', status: 'ok', rc: 0, startedAt: t0 + 5, endedAt: t0 + 6 }])
  })

  it('чужая подпись и чужой агент — консоль отклоняет (401), карточки нет', async () => {
    const t0 = Math.floor(Date.now() / 1000) - 20
    const wrong = envFile('wrong.env', { OPS_CONSOLE_URL: consoleUrl, OPS_AGENT_ID: 'prod', OPS_AGENT_SECRET: 'hrhops_not-the-secret' })
    const ghost = envFile('ghost.env', { OPS_CONSOLE_URL: consoleUrl, OPS_AGENT_ID: 'ghost', OPS_AGENT_SECRET: secret })
    for (const env of [wrong, ghost]) {
      const r = await runHelper([...eventArgs(t0, 1, 'deploy_start'), '--env-file', env])
      expect(r).toMatchObject({ code: 2, stdout: '', stderr: '' })
      // Тот же запрос без сети — явный статус ответа сервера.
      const dry = await runHelper([...eventArgs(t0, 1, 'deploy_start'), '--env-file', env, '--dry-run'])
      const req = JSON.parse(dry.stdout) as { path: string; headers: Record<string, string>; body: string }
      expect((await app.request(req.path, { method: 'POST', headers: req.headers, body: req.body })).status).toBe(401)
    }
    expect(await cards(t0)).toHaveLength(0)
  })

  it('просроченное время — 401 и без записи; тот же запрос вовремя — принят (контроль)', async () => {
    const env = envFile('dry.env', { OPS_CONSOLE_URL: consoleUrl, OPS_AGENT_ID: 'prod', OPS_AGENT_SECRET: secret })
    const t0 = Math.floor(Date.now() / 1000) - 10
    const dry = await runHelper([...eventArgs(t0, 1, 'deploy_start'), '--env-file', env, '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.stdout).not.toContain(secret)
    const req = JSON.parse(dry.stdout) as { path: string; headers: Record<string, string>; body: string }
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 6 * 60_000)
      expect((await app.request(req.path, { method: 'POST', headers: req.headers, body: req.body })).status).toBe(401)
    } finally {
      vi.useRealTimers()
    }
    expect(await cards(t0)).toHaveLength(0)
    expect((await app.request(req.path, { method: 'POST', headers: req.headers, body: req.body })).status).toBe(200)
    expect(await cards(t0)).toHaveLength(1)
  })

  it('не держит унаследованный flock обёртки деплоя: живой помощник не блокирует следующий деплой', () => {
    // Обёртка hrhelper-deploy держит flock на fd 9, его наследует каждый потомок деплоя. Помощник висит на
    // молчащей консоли (~3 с), «деплой» закрывает свою копию — блокировка должна освободиться сразу.
    const probe = `
import fcntl, os, socket, subprocess, sys, time
helper, d = sys.argv[1], sys.argv[2]
srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(5)
env = os.path.join(d, "fd.env")
open(env, "w").write("OPS_CONSOLE_URL=http://127.0.0.1:%d\\nOPS_AGENT_ID=prod\\nOPS_AGENT_SECRET=s\\n" % srv.getsockname()[1])
lock = os.path.join(d, "deploy.lock")
fd = os.open(lock, os.O_CREAT | os.O_WRONLY)
fcntl.flock(fd, fcntl.LOCK_EX)
t = str(int(time.time()))
p = subprocess.Popen([sys.executable, "-I", helper, "--event", "deploy_start", "--seq", "1", "--sha", "a" * 40,
                      "--started", t, "--now", t, "--env-file", env], pass_fds=(fd,))
time.sleep(0.8)
os.close(fd)
other = os.open(lock, os.O_WRONLY)
try:
    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("free" if p.poll() is None else "helper-exited-early")
except BlockingIOError:
    print("held")
p.kill()
`
    const r = spawnSync('python3', ['-I', '-c', probe, HELPER, dir], { encoding: 'utf8', timeout: 15_000 })
    expect(r.stdout.trim()).toBe('free')
  })

  it('нет файла учётки, нет прав на него или ключей — тихий выход 0 без сети', async () => {
    const t0 = Math.floor(Date.now() / 1000)
    const locked = envFile('locked.env', { OPS_CONSOLE_URL: consoleUrl, OPS_AGENT_ID: 'prod', OPS_AGENT_SECRET: secret })
    chmodSync(locked, 0o000)
    const partial = envFile('partial.env', { OPS_CONSOLE_URL: consoleUrl, OPS_AGENT_ID: 'prod' })
    const remote = envFile('http.env', { OPS_CONSOLE_URL: 'http://ops.example.test', OPS_AGENT_ID: 'prod', OPS_AGENT_SECRET: secret })
    for (const env of [join(dir, 'missing.env'), locked, partial, remote]) {
      const r = await runHelper([...eventArgs(t0, 1, 'deploy_start'), '--env-file', env])
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' })
    }
    expect(await cards(t0)).toHaveLength(0)
  })
})
