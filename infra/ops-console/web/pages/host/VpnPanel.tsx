/**
 * WireGuard на хосте (агент ≥ 1.6 со сборщиком hrh-ops-vpn): пиры — качество связи и трафик — видят все роли;
 * внешние адреса пиров и куда они ходили — только владелец (отдельный запрос /infra/agents/:id/vpn).
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { bytes, bytesPerSec, timeAgo } from '../../lib/format'
import type { AgentSummary, VpnOwnerData, VpnPeer, VpnSummary, VpnWindow } from '../../lib/types'
import { StatusBadge } from '../../ui/Badge'
import { Tabs } from '../../ui/Controls'
import { Empty, LoadError, Panel, Skeleton } from '../../ui/Glass'
import ui from '../../ui/styles'
import s from '../pages.module.css'

const PORTS: Record<string, string> = {
  'tcp:443': 'HTTPS',
  'udp:443': 'QUIC',
  'tcp:80': 'HTTP',
  'udp:53': 'DNS',
  'tcp:53': 'DNS',
  'tcp:853': 'DNS over TLS',
  'tcp:22': 'SSH',
  'tcp:993': 'IMAP',
  'tcp:587': 'SMTP',
  'tcp:5222': 'XMPP',
  'tcp:5228': 'Google Push',
  'udp:3478': 'STUN',
  'udp:123': 'NTP',
}

function service(proto: string, port: number): string {
  const name = PORTS[`${proto}:${port}`]
  if (proto === 'icmp') return 'ICMP'
  return name ? `${name} · ${proto}/${port}` : `${proto}/${port}`
}

function age(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return 'не было'
  if (sec < 90) return `${Math.round(sec)} с назад`
  if (sec < 5400) return `${Math.round(sec / 60)} мин назад`
  if (sec < 172_800) return `${Math.round(sec / 3600)} ч назад`
  return `${Math.round(sec / 86_400)} дн назад`
}

/** Почему данных нет или они устарели — с тем, что проверить на сервере. */
function StateNote({ vpn }: { vpn: VpnSummary }) {
  if (vpn.state === 'ok') return null
  const text =
    vpn.state === 'stale'
      ? `Сборщик VPN не обновлял данные ${vpn.at ? timeAgo(vpn.at * 1000) : 'давно'} — проверьте на сервере: systemctl status hrh-ops-vpn. Цифры ниже — последние известные.`
      : vpn.state === 'no_wg'
        ? 'Сборщик работает, но не видит интерфейсов WireGuard (wg show interfaces пуст).'
        : vpn.error === 'no_access'
          ? 'Агент не может прочитать файл сборщика: файл должен принадлежать группе hrh-ops (юнит hrh-ops-vpn.service ставит её сам — переустановите юнит).'
          : `Файл сборщика не прочитан (${vpn.error ?? vpn.state}) — journalctl -u hrh-ops-vpn -n 50.`
  return <p className={s.warning}>{text}</p>
}

function Peers({ peers, drift, endpoints }: { peers: VpnPeer[]; drift: number; endpoints: Map<string, string> | null }) {
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Клиент</th>
            <th>Связь</th>
            <th className={ui.num}>Скорость ↓ / ↑</th>
            <th className={ui.num}>Всего ↓ / ↑</th>
            <th className={ui.num}>RTT · потери</th>
            {endpoints ? <th>Внешний адрес</th> : null}
          </tr>
        </thead>
        <tbody>
          {peers.map((p) => (
            <tr key={`${p.iface}-${p.ip}`}>
              <td>
                <span className={ui.cellMain}>{p.name}</span>
                {p.name !== p.ip ? <span className={ui.cellSub}> {p.ip}</span> : null}
              </td>
              <td>
                <StatusBadge status={p.online ? 'healthy' : 'unknown'} label={p.online ? 'на связи' : 'нет связи'} />
                <span className={ui.cellSub}> рукопожатие {age(p.handshakeAgeSec === null ? null : p.handshakeAgeSec + drift)}</span>
              </td>
              <td className={ui.num}>
                {p.txBps === undefined && p.rxBps === undefined ? '—' : `${bytesPerSec(p.txBps)} / ${bytesPerSec(p.rxBps)}`}
              </td>
              <td className={ui.num}>
                {bytes(p.tx)} / {bytes(p.rx)}
              </td>
              <td className={ui.num}>
                {p.rttMs === undefined ? '—' : `${Math.round(p.rttMs)} мс · ${Math.round(p.lossPct ?? 0)}%`}
              </td>
              {endpoints ? <td className={s.code}>{endpoints.get(p.ip) ?? '—'}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Destinations({ win, acct }: { win: VpnWindow | undefined; acct: boolean }) {
  if (!win || !win.rows.length) return <Empty title="Направлений пока нет">Окно копится с запуска сборщика, направления обновляются раз в 5 минут.</Empty>
  const [up, down, conns] = win.total
  return (
    <>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Клиент</th>
              <th>Куда</th>
              <th>Протокол</th>
              <th className={ui.num}>{acct ? 'Получено ↓ / отправлено ↑' : 'Соединений'}</th>
              {acct ? <th className={ui.num}>Соединений</th> : null}
            </tr>
          </thead>
          <tbody>
            {win.rows.map((r) => (
              <tr key={`${r.peer}-${r.proto}-${r.dst}-${r.port}`}>
                <td>{r.peer}</td>
                <td>
                  <span className={ui.cellMain}>{r.host ?? r.dst}</span>
                  {r.host ? <span className={ui.cellSub}> {r.dst}</span> : null}
                </td>
                <td>{service(r.proto, r.port)}</td>
                <td className={ui.num}>{acct ? `${bytes(r.down)} / ${bytes(r.up)}` : r.conns}</td>
                {acct ? <td className={ui.num}>{r.conns}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={ui.muted}>
        Показано {win.rows.length} из {win.keys} направлений. Всего за окно: {acct ? `${bytes(down)} получено, ${bytes(up)} отправлено, ` : ''}
        {conns} новых соединений.
      </p>
    </>
  )
}

function OwnerDestinations({ data, vpn }: { data: VpnOwnerData; vpn: VpnSummary }) {
  const [win, setWin] = useState<'h1' | 'h24'>('h1')
  return (
    <>
      <div className={s.toolbar}>
        <h3 className={ui.panelTitle}>Куда ходили клиенты</h3>
        <Tabs
          label="Окно"
          value={win}
          onChange={setWin}
          items={[
            { id: 'h1', label: 'Час' },
            { id: 'h24', label: 'Сутки' },
          ]}
        />
      </div>
      {vpn.flowsSource === 'none' ? (
        <p className={s.warning}>
          Сборщик не видит таблицу соединений: нет /proc/net/nf_conntrack и утилиты conntrack — установите пакет conntrack (apt install conntrack).
        </p>
      ) : vpn.flowsAcct === false ? (
        <p className={ui.muted}>
          Учёт байт в conntrack выключен — видно только число соединений. Включить: sysctl net.netfilter.nf_conntrack_acct=1 (действует для новых
          соединений).
        </p>
      ) : null}
      {vpn.flowsTruncated ? <p className={s.warning}>Таблица соединений больше лимита сборщика — часть потоков не учтена.</p> : null}
      <Destinations win={data.destinations[win]} acct={vpn.flowsAcct !== false} />
      <p className={ui.muted}>
        Имена — обратный DNS адреса (PTR), подтверждённый прямым запросом: это имя сервера, а не сайта, и сайты за CDN покажут имя CDN. Данные на {timeAgo(data.capturedAt)}.
      </p>
    </>
  )
}

export function VpnPanel({ agent }: { agent: AgentSummary }) {
  const vpn = agent.snapshot?.vpn
  const { can } = useSession()
  const owner = can('owner')
  const q = useQuery({
    queryKey: ['agent-vpn', agent.id],
    queryFn: () => api.get<{ vpn: VpnOwnerData | null }>(`/infra/agents/${encodeURIComponent(agent.id)}/vpn`),
    enabled: owner && Boolean(vpn),
    refetchInterval: 300_000, // агент присылает направления раз в 5 минут
  })
  if (!vpn) return null
  const drift = agent.snapshot?.receivedAt ? Math.max(0, (Date.now() - agent.snapshot.receivedAt) / 1000) : 0
  const endpoints = owner && q.data?.vpn ? new Map(q.data.vpn.endpoints.map((e) => [e.ip, e.endpoint])) : null
  const online = vpn.peers.filter((p) => p.online).length
  return (
    <Panel
      title="VPN (WireGuard)"
      hint={`На связи ${online} из ${vpn.peers.length}. ↓ — к клиенту, ↑ — от клиента; RTT и потери — ping по туннелю раз в 5 минут, пока клиент активен.`}
    >
      <StateNote vpn={vpn} />
      {vpn.peers.length ? <Peers peers={vpn.peers} drift={drift} endpoints={endpoints} /> : <p className={ui.muted}>Пиров нет.</p>}
      <hr className={ui.divider} />
      {!owner ? (
        <p className={ui.muted}>Направления трафика и внешние адреса клиентов видит только владелец.</p>
      ) : q.error ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <Skeleton height={120} />
      ) : q.data.vpn ? (
        <OwnerDestinations data={q.data.vpn} vpn={vpn} />
      ) : (
        <p className={ui.muted}>Направлений ещё нет: агент присылает их со второго снимка сборщика (через ~30 секунд после запуска), дальше — раз в 5 минут.</p>
      )}
    </Panel>
  )
}
