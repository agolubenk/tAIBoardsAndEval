/**
 * Ветки алертов в Telegram и честный итог: срабатывание — карточка, дальше — ответы на неё,
 * карточка переписывается под статус; восстановление несёт данные наблюдения «в норме».
 * Сквозная часть — на временной БД, Telegram API перехвачен на уровне httpRequest.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { eq } from 'drizzle-orm'
import { freshApp } from './helpers'
import { getDb } from '../server/db/client'
import { alerts, channels, deliveries } from '../server/db/schema'
import { encryptJson } from '../server/lib/crypto'
import { observe, resolveAlert, type Observation } from '../server/alerts/store'
import { alertCardHtml, alertReplyHtml, type AlertMessage } from '../server/notify/format'
import { fitTelegram, messageIdInChat } from '../server/notify/senders'
import * as http from '../server/lib/http'

const base: AlertMessage = {
  event: 'firing',
  alertId: 7,
  severity: 'warning',
  title: 'Ошибки 5xx в nginx',
  object: 'Contabo · prod',
  value: '5xx в минуту: 24',
  detail: '',
  facts: [['Сейчас', '24']],
  hint: 'смотрите логи backend',
  links: [],
  link: 'https://ops.example.com/infrastructure/prod',
  startedAt: Date.UTC(2026, 9, 8, 7, 28),
  resolvedAt: null,
  resolution: '',
  closedBy: null,
  incidentId: null,
  timeZone: 'Europe/Minsk',
  now: Date.UTC(2026, 9, 8, 7, 31, 5),
}

describe('карточка и ответы ветки', () => {
  it('ответ короткий: статус, сводка, длительность — без фактов и ссылок', () => {
    const resolved = { ...base, event: 'resolved' as const, resolvedAt: Date.UTC(2026, 9, 8, 7, 31), resolution: '5xx/мин сейчас 0' }
    expect(alertReplyHtml(resolved)).toBe('🟢 <b>ВОССТАНОВЛЕНО (🟠 внимание)</b> — 5xx/мин сейчас 0 · длилось 3 мин')
    expect(alertReplyHtml({ ...base, event: 'repeat' })).toBe('🟠 <b>ВСЁ ЕЩЁ ГОРИТ</b> — 5xx в минуту: 24 · горит 3 мин')
    expect(alertReplyHtml({ ...base, event: 'closed', closedBy: 'owner@ops', resolvedAt: base.now! })).toBe(
      '⚪️ <b>ЗАКРЫТ ВРУЧНУЮ (🟠 внимание)</b> — закрыто: owner@ops · горело 3 мин',
    )
  })

  it('ссылка на сообщение действует только в своём чате; длинный текст режется по строке', () => {
    expect(messageIdInChat('-100:500', '-100')).toBe(500)
    expect(messageIdInChat('-100:500', '-200')).toBeNull()
    expect(messageIdInChat('-100:abc', '-100')).toBeNull()
    const long = Array.from({ length: 300 }, (_, i) => `• факт ${i}: <b>${'&amp;'.repeat(3)}</b>`).join('\n')
    const cut = fitTelegram(long)
    expect(cut.length).toBeLessThanOrEqual(4000)
    expect(cut.endsWith('</b>\n…')).toBe(true)
  })

  it('карточка горящего алерта помечена временем обновления, итоговая — нет', () => {
    expect(alertCardHtml({ ...base, event: 'repeat' })).toMatch(/<i>обновлено 10:31:05<\/i>$/)
    const done = alertCardHtml({ ...base, event: 'resolved', resolvedAt: Date.UTC(2026, 9, 8, 7, 31), resolution: 'норма' })
    // Уровень алерта остаётся первой строкой итоговой карточки: история канала не «вся зелёная».
    expect(done.startsWith('🟠 <b>ВНИМАНИЕ · Ошибки 5xx в nginx</b>\n')).toBe(true)
    expect(done).toContain('🟢 <b>ВОССТАНОВЛЕНО</b> · <b>Contabo · prod</b> — норма')
    expect(done).toContain('⏱ длилось 3 мин (10:28 → 10:31)')
    expect(done).not.toContain('обновлено')
  })
})

type TgCall = { method: string; body: Record<string, unknown> }

describe('ветка в Telegram (сквозной)', () => {
  let calls: TgCall[]
  let nextId: number
  let spy: MockInstance<typeof http.httpRequest>
  const rule: Observation['rule'] = { id: 999, forSamples: 1, severity: 'warning', repeatMin: 0 }
  const obs = (breached: boolean, now: string): Observation => ({
    rule,
    fingerprint: 'test:5xx',
    breached,
    title: 'Ошибки 5xx в nginx',
    object: 'Contabo · prod',
    value: `5xx в минуту: ${now}`,
    facts: [['Сейчас', now]],
    recovery: `5xx/мин сейчас ${now}`,
  })

  beforeEach(async () => {
    await freshApp()
    await getDb()
      .insert(channels)
      .values({ kind: 'telegram', name: 'tg', configJson: JSON.stringify({ chatId: '-100' }), secretEnc: encryptJson({ botToken: 'T' }) })
    calls = []
    nextId = 500
    spy = vi.spyOn(http, 'httpRequest').mockImplementation(async (url, opts) => {
      const method = url.split('/').at(-1) ?? ''
      calls.push({ method, body: JSON.parse(String(opts?.body ?? '{}')) as Record<string, unknown> })
      const result = method === 'sendMessage' ? { message_id: nextId++ } : true
      return { status: 200, ok: true, text: JSON.stringify({ ok: true, result }), latencyMs: 1 }
    })
  })
  afterEach(() => spy.mockRestore())

  it('срабатывание — карточка; восстановление — ответ на неё и правка карточки со свежими фактами', async () => {
    expect(await observe(obs(true, '24'))).toBe('fired')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'sendMessage' })
    expect(calls[0]!.body.reply_parameters).toBeUndefined()

    expect(await observe(obs(false, '0'))).toBe('resolved')
    const [reply, edit] = calls.slice(1)
    expect(reply).toMatchObject({ method: 'sendMessage', body: { reply_parameters: { message_id: 500, allow_sending_without_reply: true } } })
    expect(String(reply!.body.text)).toMatch(/^🟢 <b>ВОССТАНОВЛЕНО \(🟠 внимание\)<\/b> — 5xx\/мин сейчас 0 · длилось/)
    expect(edit).toMatchObject({ method: 'editMessageText', body: { message_id: 500, parse_mode: 'HTML' } })
    expect(String(edit!.body.text)).toMatch(/^🟠 <b>ВНИМАНИЕ · Ошибки 5xx в nginx<\/b>\n🟢 <b>ВОССТАНОВЛЕНО<\/b> · /)
    expect(String(edit!.body.text)).toContain('• Сейчас: <b>0</b>') // не «24» последнего сбоя

    const row = await getDb().query.alerts.findFirst({ where: eq(alerts.fingerprint, 'test:5xx') })
    expect(row?.factsJson).toBe('[["Сейчас","24"]]') // строка алерта хранит, что сломалось
    const sent = await getDb().query.deliveries.findMany({ where: eq(deliveries.alertId, row!.id) })
    expect(sent.map((d) => [d.kind, d.externalId])).toEqual([
      ['alert', '-100:500'],
      ['resolved', null],
    ])
  })

  it('ручное закрытие — тоже ответом; удалённая карточка не ломает доставку', async () => {
    await observe(obs(true, '24'))
    spy.mockImplementation(async (url, opts) => {
      const method = url.split('/').at(-1) ?? ''
      calls.push({ method, body: JSON.parse(String(opts?.body ?? '{}')) as Record<string, unknown> })
      if (method === 'editMessageText') {
        return { status: 400, ok: false, text: JSON.stringify({ ok: false, description: 'Bad Request: message to edit not found' }), latencyMs: 1 }
      }
      return { status: 200, ok: true, text: JSON.stringify({ ok: true, result: { message_id: nextId++ } }), latencyMs: 1 }
    })
    const active = await getDb().query.alerts.findFirst({ where: eq(alerts.status, 'firing') })
    await resolveAlert(active!, '', 'owner@ops')
    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'sendMessage', 'editMessageText'])
    expect(String(calls[1]!.body.text)).toContain('ЗАКРЫТ ВРУЧНУЮ')
    const ch = await getDb().query.channels.findFirst()
    expect(ch?.lastError).toBeNull() // правка карточки — косметика, канал не красится
  })

  it('мигание: карточка «МИГАЕТ» после закрытия молча переписывается в итог', async () => {
    for (let i = 0; i < 2; i++) {
      await observe(obs(true, '24'))
      await observe(obs(false, '0'))
    }
    calls.splice(0)
    expect(await observe(obs(true, '24'))).toBe('fired') // третий за час → «мигает»
    expect(String(calls[0]!.body.text)).toContain('МИГАЕТ')
    await observe(obs(false, '0')) // восстановление при мигании не рассылается…
    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'editMessageText']) // …но карточка закрыта
    expect(String(calls[1]!.body.text)).toContain('ВОССТАНОВЛЕНО')
  })

  it('сменили чат канала — старая карточка не используется: ни ответа в чужое сообщение, ни правки', async () => {
    await observe(obs(true, '24'))
    await getDb().update(channels).set({ configJson: JSON.stringify({ chatId: '-200' }) })
    await observe(obs(false, '0'))
    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'sendMessage'])
    expect(calls[1]!.body).toMatchObject({ chat_id: '-200' })
    expect(calls[1]!.body.reply_parameters).toBeUndefined()
  })

  it('нет карточки (сообщение до этой версии) — полным сообщением, как раньше', async () => {
    await observe(obs(true, '24'))
    await getDb().update(deliveries).set({ externalId: null })
    await observe(obs(false, '0'))
    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'sendMessage'])
    expect(calls[1]!.body.reply_parameters).toBeUndefined()
    expect(String(calls[1]!.body.text)).toContain('Открыть в консоли')
  })
})

describe('деплои: ветки, заголовок коммита, итог восстановления', () => {
  it('запуск с ветки не трогает алерт; восстановление — коммит и ссылка успешного запуска', async () => {
    await freshApp()
    const { pollGithubDeploys } = await import('../server/deploys/github')
    const { writeSetting } = await import('../server/settings/store')
    await writeSetting('github', { repo: 'acme/app', workflow: 'deploy.yml', tokenEnc: null })
    await getDb()
      .insert(channels)
      .values({ kind: 'telegram', name: 'tg', configJson: JSON.stringify({ chatId: '-100' }), secretEnc: encryptJson({ botToken: 'T' }) })
    const tg: TgCall[] = []
    const now = Date.now()
    const run = (id: number, extra: Record<string, unknown>) => ({
      id,
      status: 'completed',
      head_branch: 'main',
      display_title: 'deploy.yml',
      run_started_at: new Date(now - 10 * 60_000).toISOString(),
      updated_at: new Date(now - 60_000).toISOString(),
      ...extra,
    })
    let runs = [run(1, { conclusion: 'failure', head_sha: 'aaa1111', head_commit: { message: 'fix: что-то\n\nтело' }, html_url: 'https://gh/1' })]
    const spy = vi.spyOn(http, 'httpRequest').mockImplementation(async (url, opts) => {
      if (url.includes('api.telegram.org')) {
        const method = url.split('/').at(-1) ?? ''
        tg.push({ method, body: JSON.parse(String(opts?.body ?? '{}')) as Record<string, unknown> })
        return { status: 200, ok: true, text: JSON.stringify({ ok: true, result: { message_id: 700 + tg.length } }), latencyMs: 1 }
      }
      const jobs = [{ steps: [{ name: 'deploy' }] }]
      const text = url.includes('/jobs') ? JSON.stringify({ jobs }) : JSON.stringify({ workflow_runs: runs })
      return { status: 200, ok: true, text, latencyMs: 1 }
    })
    try {
      await pollGithubDeploys()
      let alert = await getDb().query.alerts.findFirst()
      expect(alert?.status).toBe('firing')
      expect(alert?.factsJson).toContain('aaa1111 «fix: что-то»')
      expect(alert?.factsJson).toContain('9 мин')

      // Проверочный запуск с ветки (раннер отклонил) — ни продления, ни новых фактов.
      runs = [
        run(2, { conclusion: 'failure', head_branch: 'fix/x', head_sha: 'bbb2222', head_commit: { message: 'ветка' }, html_url: 'https://gh/2' }),
        ...runs,
      ]
      await pollGithubDeploys()
      alert = await getDb().query.alerts.findFirst()
      expect(alert?.factsJson).not.toContain('bbb2222')

      // Ручной запуск (откат через Run workflow): head_commit — вершина main, не выкаченный коммит.
      runs = [
        run(4, { conclusion: 'failure', event: 'workflow_dispatch', head_sha: 'ddd4444', head_commit: { message: 'вершина main' }, html_url: 'https://gh/4' }),
        ...runs,
      ]
      await pollGithubDeploys()
      alert = await getDb().query.alerts.findFirst()
      expect(alert?.factsJson).toContain('ручной запуск (Run workflow) — коммит в логе запуска')
      expect(alert?.factsJson).not.toContain('вершина main')

      runs = [run(3, { conclusion: 'success', head_sha: 'ccc3333', head_commit: { message: 'Merge #95' }, html_url: 'https://gh/3' }), ...runs]
      await pollGithubDeploys()
      alert = await getDb().query.alerts.findFirst()
      expect(alert?.status).toBe('resolved')
      expect(alert?.resolution).toBe('следующий деплой успешен: ccc3333 «Merge #95»')
      // То самое сообщение: итог несёт успешный запуск, а не упавший/ручной/ветку.
      const card = String(tg.find((c) => c.method === 'editMessageText')?.body.text)
      expect(card).toContain('ВОССТАНОВЛЕНО</b> · ')
      expect(card).toContain('ccc3333 «Merge #95»')
      expect(card).toContain('https://gh/3')
      for (const stale of ['bbb2222', 'https://gh/2', 'https://gh/4', 'ручной запуск (Run']) expect(card).not.toContain(stale)
      expect(tg.find((c) => c.body.reply_parameters)?.body.text).toMatch(/следующий деплой успешен: ccc3333/)
    } finally {
      spy.mockRestore()
    }
  })
})
