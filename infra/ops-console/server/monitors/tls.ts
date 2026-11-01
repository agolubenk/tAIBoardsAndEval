/** Срок TLS-сертификатов доменов из HTTPS-мониторов (раз в 6 часов). */
import net from 'node:net'
import tls from 'node:tls'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { monitors, tlsChecks } from '../db/schema'
import { getRulesByKind, observe } from '../alerts/store'
import { resolveTarget } from '../lib/http'
import { getEgressAllowlist } from '../settings/store'

/**
 * Куда подключаться за сертификатом: те же правила, что у HTTP-проверок (`lib/http.ts`) — все адреса
 * имени публичные или из «Внутренних адресов», метаданные облака и loopback запрещены всегда. Подключение
 * идёт к проверенному адресу, а не к имени: повторный DNS-ответ (rebinding) не уведёт его внутрь.
 * Без этого мониторы, которые заводит оператор, позволяли бы прощупывать внутреннюю сеть на :443.
 */
export async function tlsConnectTarget(
  domain: string,
  allowPrivateHosts: readonly string[] = [],
): Promise<{ host: string; servername?: string }> {
  const target = await resolveTarget(new URL(`https://${domain}/`), allowPrivateHosts)
  const name = domain.replace(/^\[|\]$/g, '')
  // SNI — только для имён: для IP-литерала Node его не принимает.
  return { host: target.address, servername: net.isIP(name) ? undefined : name }
}

async function fetchCert(domain: string, allowPrivateHosts: readonly string[]): Promise<{ validTo: Date; issuer: string }> {
  const { host, servername } = await tlsConnectTarget(domain, allowPrivateHosts)
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate()
      socket.destroy()
      if (!cert?.valid_to) return reject(new Error('сертификат не получен'))
      const issuer = cert.issuer?.O
      resolve({ validTo: new Date(cert.valid_to), issuer: Array.isArray(issuer) ? issuer.join(', ') : (issuer ?? '') })
    })
    socket.on('error', reject)
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('таймаут TLS'))
    })
  })
}

export async function checkTlsCertificates(): Promise<number> {
  const db = getDb()
  const all = await db.query.monitors.findMany({ where: eq(monitors.enabled, true), limit: 100 })
  const domains = new Set<string>()
  for (const m of all) {
    if (m.type !== 'http') continue
    try {
      const u = new URL(m.url)
      if (u.protocol === 'https:') domains.add(u.hostname)
    } catch {
      /* некорректный URL не проверяем */
    }
  }
  const [rules, allow] = await Promise.all([getRulesByKind('tls_expiry'), getEgressAllowlist()])
  await Promise.all(
    [...domains].map(async (domain) => {
      let row: typeof tlsChecks.$inferInsert = { domain, issuer: '', validTo: null, daysLeft: null, error: null, checkedAt: new Date() }
      try {
        const cert = await fetchCert(domain, allow)
        row = {
          ...row,
          issuer: cert.issuer,
          validTo: cert.validTo,
          daysLeft: Math.floor((cert.validTo.getTime() - Date.now()) / 86_400_000),
        }
      } catch (err) {
        row.error = (err instanceof Error ? err.message : String(err)).slice(0, 300)
      }
      await db.insert(tlsChecks).values(row).onConflictDoUpdate({ target: tlsChecks.domain, set: row })
      if (row.daysLeft === null || row.daysLeft === undefined) return
      for (const rule of rules) {
        const until = row.validTo ? row.validTo.toLocaleDateString('ru-RU', { timeZone: 'UTC' }) : '—'
        await observe({
          rule,
          fingerprint: `rule:${rule.id}:tls:${domain}`,
          breached: row.daysLeft < rule.threshold,
          title: rule.name,
          object: domain,
          value: `истекает через ${row.daysLeft} дн. (${until})`,
          facts: [
            ['Действует до', until],
            ['Осталось', `${row.daysLeft} дн. (порог ${rule.threshold})`],
            ['Издатель', row.issuer || '—'],
          ],
          hint: 'Let’s Encrypt продлевается сам за 30 дней до конца срока (контейнер certbot). Если не продлился — docker logs --tail 100 backend-certbot-1, затем docker exec backend-certbot-1 certbot renew.',
          route: '/monitoring?tab=tls',
          recovery: `сертификат обновлён: действует до ${until}`,
        })
      }
    }),
  )
  return domains.size
}
