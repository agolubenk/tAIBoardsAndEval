/** Плитки главной: сервисы, серверы, контейнеры, ресурсы у порога, домены и TLS, уведомления. */
import { timeAgo } from '../../lib/format'
import type { Overview, WatchedResource } from '../../lib/types'
import { StatTile } from '../../ui/Glass'
import { plural } from '../../../shared/plural'
import s from '../pages.module.css'

const METRIC_SHORT: Record<WatchedResource['metric'], string> = { cpu_pct: 'CPU', mem_pct: 'RAM', disk_pct: 'Диск' }

export function OverviewTiles({ o, resources }: { o: Overview | undefined; resources: WatchedResource[] | undefined }) {
  const k = o?.kpis
  const enabled = o?.monitors.filter((m) => m.enabled) ?? []
  const down = enabled.filter((m) => m.lastOk === false).length
  const up = enabled.filter((m) => m.lastOk).length
  const silent = o?.agents.filter((a) => a.status === 'unknown' || a.status === 'pending').length ?? 0
  const online = (o?.agents.length ?? 0) - silent
  const c = k?.containers
  const containerIssues = c ? c.restarting + c.unhealthy + c.stopped : 0
  const hot = resources?.filter((r) => r.level !== 'watch') ?? []
  const n = k?.notifications
  const failing = n ? n.failing.length + n.subscriptionsFailing : 0

  return (
    <div className={s.kpiGrid}>
      <StatTile
        label="Сервисы"
        icon="globe"
        to="/monitoring"
        value={o ? `${up} из ${enabled.length}` : '—'}
        sub={!o ? ' ' : down ? `${plural(down, ['недоступен', 'недоступны', 'недоступны'])}` : enabled.length ? 'все доступны снаружи' : 'проверок нет'}
        tone={down ? 'critical' : undefined}
      />
      <StatTile
        label="Серверы"
        icon="server"
        to="/infrastructure"
        value={o ? `${online} на связи` : '—'}
        sub={!o ? ' ' : silent ? `${plural(silent, ['молчит', 'молчат', 'молчат'])}` : o.agents.length ? 'все отчитываются' : 'агентов нет'}
        tone={silent ? 'attention' : undefined}
      />
      <StatTile
        label="Контейнеры"
        icon="box"
        to="/infrastructure?type=container"
        value={c ? `${c.running} / ${c.total}` : '—'}
        sub={
          !c
            ? ' '
            : containerIssues
              ? [c.restarting && `перезапускается ${c.restarting}`, c.unhealthy && `unhealthy ${c.unhealthy}`, c.stopped && `упало ${c.stopped}`]
                  .filter(Boolean)
                  .join(' · ')
              : 'все работают'
        }
        tone={containerIssues ? 'critical' : undefined}
      />
      <StatTile
        label="Ресурсы"
        icon="gauge"
        to="#resources"
        value={resources ? (hot.length ? `${plural(hot.length, ['порог', 'порога', 'порогов'])}` : 'в норме') : '—'}
        sub={
          !resources
            ? ' '
            : hot.length
              ? hot
                  .slice(0, 3)
                  .map((r) => `${METRIC_SHORT[r.metric]} ${r.host}`)
                  .join(' · ')
              : 'ничего не подходит к порогам'
        }
        tone={hot.some((r) => r.level === 'critical') ? 'critical' : hot.length ? 'attention' : undefined}
      />
      <StatTile
        label="Домены и TLS"
        icon="shield"
        to="/monitoring?tab=tls"
        value={k ? (k.tls.atRisk ? `${plural(k.tls.atRisk, ['риск', 'риска', 'рисков'])}` : k.tls.total ? 'в норме' : '—') : '—'}
        sub={
          !k?.tls.nearest
            ? k
              ? 'доменов нет'
              : ' '
            : k.tls.nearest.error
              ? `${k.tls.nearest.domain}: ошибка проверки`
              : `ближайший ${k.tls.nearest.domain} — ${plural(k.tls.nearest.daysLeft ?? 0, ['день', 'дня', 'дней'])}`
        }
        tone={k?.tls.atRisk ? 'attention' : undefined}
      />
      <StatTile
        label="Уведомления"
        icon="send"
        to="/alerts?tab=channels"
        value={n ? (failing ? 'Ошибка' : n.channels + n.subscriptions ? 'Работают' : 'Не настроены') : '—'}
        sub={
          !n
            ? ' '
            : n.failing.length
              ? `${n.failing[0]!.name}: ${n.failing[0]!.error || 'ошибка доставки'}`
              : n.subscriptionsFailing
                ? `не доставлено в ${plural(n.subscriptionsFailing, ['личную подписку', 'личные подписки', 'личных подписок'])}`
                : n.lastOkAt
                  ? `последняя доставка ${timeAgo(n.lastOkAt)}`
                  : `${plural(n.channels, ['канал', 'канала', 'каналов'])} · ${plural(n.subscriptions, ['подписка', 'подписки', 'подписок'])}`
        }
        tone={failing ? 'critical' : n && !n.channels && !n.subscriptions ? 'attention' : undefined}
      />
    </div>
  )
}
