/** «Агент молчит»: нет отчётов дольше N интервалов — хост, docker или сеть недоступны. */
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agents, monitors } from '../db/schema'
import { getRulesByKind, observe, type Fact } from '../alerts/store'
import { getGeneralSettings, readMarker } from '../settings/store'
import { clock, humanDuration } from '../lib/time'

/**
 * Консоль сама была выключена (локальный рестарт): агент всё это время не мог отчитаться и
 * ждёт своей паузы повтора (до 60 с). Пока не прошло окно тишины + эта пауза с момента старта,
 * старую тишину не оцениваем вовсе — ни новый алерт, ни закрытие уже горящего.
 */
export function silenceSuppressed(lastSeenMs: number, upSinceMs: number, windowMs: number, now = Date.now()): boolean {
  return upSinceMs > 0 && lastSeenMs < upSinceMs && now < upSinceMs + windowMs + 60_000
}

export function isAgentSilent(lastSeenAt: Date | null, intervalSec: number, afterIntervals: number, now = Date.now()): boolean {
  // Агент, ни разу не приславший отчёт, — «ожидает подключения», а не авария.
  if (!lastSeenAt) return false
  return now - lastSeenAt.getTime() > intervalSec * afterIntervals * 1000
}

interface SnapshotLite {
  cpu?: { pct?: number }
  memory?: { totalMb?: number; usedMb?: number }
  disks?: Array<{ totalGb: number; usedGb: number }>
  /** Снимок агента до 1.5 / консоли до 1.5 — весь список; теперь только счётчики. */
  containers?: Array<{ state: string }>
  containerCounts?: { running: number; total: number }
}

/** «CPU 22% · RAM 28% · диск 32% · контейнеров 16/16» — последнее, что агент успел прислать. */
export function lastStateLine(json: string | null): string | null {
  if (!json) return null
  let s: SnapshotLite
  try {
    s = JSON.parse(json) as SnapshotLite
  } catch {
    return null
  }
  const parts: string[] = []
  if (typeof s.cpu?.pct === 'number') parts.push(`CPU ${Math.round(s.cpu.pct)}%`)
  if (s.memory?.totalMb && typeof s.memory.usedMb === 'number') parts.push(`RAM ${Math.round((s.memory.usedMb / s.memory.totalMb) * 100)}%`)
  const disk = (s.disks ?? []).filter((d) => d.totalGb > 0).map((d) => (d.usedGb / d.totalGb) * 100)
  if (disk.length) parts.push(`диск ${Math.round(Math.max(...disk))}%`)
  if (s.containerCounts) parts.push(`контейнеров ${s.containerCounts.running}/${s.containerCounts.total}`)
  else if (s.containers) parts.push(`контейнеров ${s.containers.filter((c) => c.state === 'running').length}/${s.containers.length}`)
  return parts.length ? parts.join(' · ') : null
}

/**
 * Главный вопрос при молчании агента: лежит прод или только канал связи с агентом?
 * Ответ — по внешним HTTP-проверкам, которые от агента не зависят.
 */
export function silenceVerdict(up: number, total: number): { fact: string; hint: string } {
  if (!total) {
    return {
      fact: 'внешних проверок нет',
      hint: 'Добавьте мониторы доменов — по ним видно, лежит ли сервер целиком. Проверьте сервер: systemctl status hrh-ops-agent.',
    }
  }
  if (up === total) {
    return {
      fact: `${up}/${total} отвечают`,
      hint: 'Сайты отвечают — прод работает, недоступен только агент или канал связи с консолью. На сервере: systemctl status hrh-ops-agent и journalctl -u hrh-ops-agent -n 30.',
    }
  }
  if (up === 0) {
    return {
      fact: `0/${total} — не отвечает ни один`,
      hint: 'Сайты тоже не отвечают — похоже, недоступен сам сервер или его сеть. Проверьте панель хостинга и SSH.',
    }
  }
  return {
    fact: `${up}/${total} отвечают`,
    hint: 'Часть сайтов не отвечает вместе с агентом — вероятны проблемы на сервере (nginx, docker, ресурсы). Проверьте сервер по SSH.',
  }
}

export async function evaluateAgentSilence(): Promise<void> {
  const db = getDb()
  const [list, rules, general, upSince, mons] = await Promise.all([
    db.query.agents.findMany({ where: eq(agents.enabled, true), limit: 50 }),
    getRulesByKind('agent_silent'),
    getGeneralSettings(),
    readMarker('up_since'),
    db.query.monitors.findMany({ where: eq(monitors.enabled, true), limit: 100 }),
  ])
  const checked = mons.filter((m) => m.lastOk !== null)
  const up = checked.filter((m) => m.lastOk).length
  const verdict = silenceVerdict(up, checked.length)
  const down = checked.filter((m) => !m.lastOk).map((m) => m.name)
  const now = Date.now()
  for (const a of list) {
    const windowMs = a.reportIntervalSec * general.agentSilentAfterIntervals * 1000
    if (a.lastSeenAt && silenceSuppressed(a.lastSeenAt.getTime(), upSince, windowMs, now)) continue
    const silent = isAgentSilent(a.lastSeenAt, a.reportIntervalSec, general.agentSilentAfterIntervals, now)
    const since = a.lastSeenAt?.getTime() ?? now
    const facts: Fact[] = [
      ['Последний отчёт', a.lastSeenAt ? clock(since, general.timezone, now, true) : '—'],
      ['Внешние проверки', verdict.fact],
    ]
    if (down.length) facts.push(['Не отвечают', down.slice(0, 4).join(', ')])
    const last = lastStateLine(a.lastSnapshotJson)
    if (last) facts.push(['Последнее состояние', last])
    for (const rule of rules.filter((r) => r.agentId === null || r.agentId === a.id)) {
      await observe({
        rule,
        fingerprint: `rule:${rule.id}:${a.id}`,
        breached: silent,
        title: rule.name,
        object: a.name,
        value: `нет отчётов ${humanDuration(now - since)}`,
        facts,
        hint: verdict.hint,
        route: `/infrastructure/${encodeURIComponent(a.id)}`,
        recovery: a.lastSeenAt ? `снова на связи, отчёт ${clock(since, general.timezone, now, true)}` : 'снова на связи',
      })
    }
  }
}
