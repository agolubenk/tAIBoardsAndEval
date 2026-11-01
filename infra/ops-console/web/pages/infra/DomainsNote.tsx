/**
 * Над вкладкой «Домены»: откуда список и чего в нём может не хватать — хост со старым агентом не присылает домены
 * nginx, а nginx, не отдавший конфигурацию, мог потерять часть имён. Без этого неполный список выглядит полным.
 */
import type { AgentDomain, AgentSummary, TlsCert } from '../../lib/types'
import ui from '../../ui/styles'

/** Домены nginx — с агента 1.5. */
export function sendsDomains(version: string | undefined): boolean {
  const [major = 0, minor = 0] = (version ?? '').split('.').map((x) => Number.parseInt(x, 10) || 0)
  return major > 1 || (major === 1 && minor >= 5)
}

export function DomainsNote({ agents, certs, hosted }: { agents: AgentSummary[]; certs: TlsCert[]; hosted: AgentDomain[] }) {
  const external = new Set(certs.map((c) => c.domain.toLowerCase()))
  const fromHosts = new Set(hosted.map((d) => d.domain))
  const onlyHosts = [...fromHosts].filter((d) => !external.has(d)).length
  const live = agents.filter((a) => a.enabled && a.snapshot)
  const old = live.filter((a) => !sendsDomains(a.snapshot?.agentVersion))
  const failed = live.flatMap((a) => (a.snapshot?.domainsFailed ?? []).map((n) => `${n} (${a.name})`))
  const cut = live.flatMap((a) => {
    const total = a.snapshot?.domainsTotal ?? 0
    const got = hosted.filter((d) => d.agentId === a.id).length
    return total > got ? [`${a.name} — ${got} из ${total}`] : []
  })
  return (
    <div style={{ padding: '0 4px 10px' }}>
      <p className={ui.cellSub}>
        С внешней проверкой HTTPS — {external.size}, из конфигурации nginx на хостах — {fromHosts.size}
        {onlyHosts ? `, из них без монитора — ${onlyHosts}` : ''}. Срок сертификата у имён без монитора проверяет агент хоста раз в 6 часов.
      </p>
      {old.length ? (
        <p className={ui.cellSub}>
          Домены nginx не присылает {old.map((a) => `${a.name} (агент ${a.snapshot?.agentVersion || '?'})`).join(', ')} — нужен агент 1.5.
        </p>
      ) : null}
      {cut.length ? (
        <p className={ui.cellSub}>
          Видны не все имена хоста: {cut.join(', ')}. Имена стека продукта присылаются первыми; лишние nginx исключите маской
          OPS_NGINX_CONTAINERS.
        </p>
      ) : null}
      {failed.length ? (
        <p className={ui.cellSub}>Не отдали конфигурацию (nginx -T): {failed.join(', ')} — их имена могут быть неполными.</p>
      ) : null}
    </div>
  )
}
