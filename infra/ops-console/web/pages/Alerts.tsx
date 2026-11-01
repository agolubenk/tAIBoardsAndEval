import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { useAction } from '../lib/hooks'
import { dateTime, duration } from '../lib/format'
import type { Alert, Delivery } from '../lib/types'
import { SeverityBadge, StatusBadge } from '../ui/Badge'
import { Button, Dialog, Field, Input, Tabs } from '../ui/Controls'
import { Empty, LoadError, PageHero, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'
import { AlertRulesPanel } from './AlertRules'
import { AlertNotesDialog } from './alerts/AlertNotes'
import { SilencesPanel } from './alerts/Silences'
import { AlertFilters, filterAlerts, type AlertFilterValue } from './alerts/AlertFilters'
import { ChannelsPanel } from './Channels'

type Tab = 'active' | 'history' | 'silences' | 'rules' | 'channels' | 'deliveries'

const SILENCE_OPTIONS: Array<[number, string]> = [
  [30, '30 минут'],
  [60, '1 час'],
  [120, '2 часа'],
  [240, '4 часа'],
  [1440, 'Сутки'],
]

function SilenceDialog({ alert, onClose }: { alert: Alert | null; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const silence = useAction((minutes: number) => api.post(`/alerts/${alert?.id}/silence`, { minutes, reason }), {
    success: 'Тишина обновлена',
    invalidate: [['alerts']],
  })
  const active = alert?.silencedUntil && alert.silencedUntil > Date.now()
  return (
    <Dialog
      open={Boolean(alert)}
      onClose={onClose}
      title="Тишина для алерта"
      actions={
        <Button variant="ghost" onClick={onClose}>
          Закрыть
        </Button>
      }
    >
      {alert ? (
        <>
          <p className={ui.muted}>
            {alert.title} — {alert.object}. Пока действует тишина, повторные уведомления не уходят; алерт продолжает гореть в консоли,
            восстановление придёт как обычно.
          </p>
          <Field label="Причина" hint="Попадёт в заметки алерта — видно, почему молчим">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="расследуем, обновление в 18:00" maxLength={500} />
          </Field>
          <div className={ui.row}>
            {SILENCE_OPTIONS.map(([min, label]) => (
              <Button
                key={min}
                busy={silence.isPending && silence.variables === min}
                onClick={() => silence.mutate(min, { onSuccess: () => (setReason(''), onClose()) })}
              >
                {label}
              </Button>
            ))}
            {active ? (
              <Button variant="ghost" onClick={() => silence.mutate(0, { onSuccess: onClose })}>
                Снять тишину
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </Dialog>
  )
}

function AlertState({ a }: { a: Alert }) {
  if (a.status === 'resolved') return <StatusBadge status="healthy" label="Восстановлен" />
  if (a.silencedUntil && a.silencedUntil > Date.now())
    return <StatusBadge status="unknown" label={`Тишина до ${dateTime(a.silencedUntil)}`} />
  if (a.acknowledgedBy) return <StatusBadge status="pending" label={`В работе: ${a.acknowledgedBy}`} />
  return <StatusBadge status={a.severity === 'critical' ? 'critical' : 'warning'} label="Горит" />
}

function AlertsTable({
  alerts,
  focus,
  history,
  onSilence,
  onNotes,
}: {
  alerts: Alert[]
  focus: number | null
  history?: boolean
  onSilence: (a: Alert) => void
  onNotes: (a: Alert) => void
}) {
  const { can } = useSession()
  const ack = useAction((id: number) => api.post(`/alerts/${id}/ack`), {
    success: 'Алерт взят в работу',
    invalidate: [['alerts'], ['overview']],
  })
  const resolve = useAction((id: number) => api.post(`/alerts/${id}/resolve`), {
    success: 'Алерт закрыт. Если условие ещё выполняется, он поднимется снова',
    invalidate: [['alerts'], ['overview']],
  })
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Важность</th>
            <th>Алерт</th>
            <th>Значение</th>
            <th>{history ? 'Длительность' : 'Горит'}</th>
            <th>Состояние</th>
            {!history && can('operator') ? <th aria-label="Действия" /> : null}
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.id} style={focus === a.id ? { background: 'var(--lg-accent-soft)' } : undefined}>
              <td>
                <SeverityBadge severity={a.severity} />
              </td>
              <td>
                {a.route ? (
                  <Link className={ui.rowLink} to={a.route}>
                    {a.title}
                  </Link>
                ) : (
                  <span className={ui.cellMain}>{a.title}</span>
                )}
                <span className={ui.cellSub}>
                  {a.object}
                  {a.detail ? ` · ${a.detail}` : ''}
                  {a.incidentId ? (
                    <>
                      {' · '}
                      <Link to={`/incidents/${a.incidentId}`}>инцидент #{a.incidentId}</Link>
                    </>
                  ) : null}
                </span>
                {a.facts.length ? (
                  <span className={ui.cellSub}>
                    {a.facts
                      .slice(0, 4)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(' · ')}
                  </span>
                ) : null}
                {a.status === 'firing' && a.hint ? <span className={ui.cellSub}>💡 {a.hint}</span> : null}
                {a.status === 'resolved' ? (
                  <span className={ui.cellSub}>{a.resolvedBy ? `закрыт вручную: ${a.resolvedBy}` : a.resolution || 'восстановлено'}</span>
                ) : null}
                <button type="button" className={`${ui.cellSub} ${ui.linkButton}`} onClick={() => onNotes(a)}>
                  {a.notes ? `💬 заметки: ${a.notes}` : '💬 заметка'}
                </button>
                {a.links.map(([label, url]) => (
                  <a key={url} className={ui.cellSub} href={url} target="_blank" rel="noreferrer">
                    {label}
                  </a>
                ))}
              </td>
              <td className={ui.num}>{a.value || '—'}</td>
              <td className={ui.num}>
                {history ? duration(a.startedAt, a.resolvedAt ?? Date.now()) : duration(a.startedAt)}
                <span className={ui.cellSub}>с {dateTime(a.startedAt)}</span>
              </td>
              <td>
                <AlertState a={a} />
              </td>
              {!history && can('operator') ? (
                <td>
                  <div className={s.actionsCell}>
                    {!a.acknowledgedBy ? (
                      <Button small busy={ack.isPending && ack.variables === a.id} onClick={() => ack.mutate(a.id)}>
                        В работу
                      </Button>
                    ) : null}
                    <Button small icon="mute" iconOnly title="Тишина — не повторять уведомления" onClick={() => onSilence(a)}>
                      Тишина
                    </Button>
                    <Button
                      small
                      variant="ghost"
                      busy={resolve.isPending && resolve.variables === a.id}
                      onClick={() => resolve.mutate(a.id)}
                    >
                      Закрыть
                    </Button>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DeliveriesPanel() {
  const q = useQuery({
    queryKey: ['deliveries'],
    queryFn: () => api.get<{ deliveries: Delivery[] }>('/alerts/deliveries'),
    refetchInterval: 30_000,
  })
  const KIND: Record<Delivery['kind'], string> = {
    alert: 'Алерт',
    resolved: 'Восстановление',
    test: 'Тест',
    digest: 'Дайджест',
    report: 'Отчёт',
  }
  return (
    <Panel title="Журнал доставки" hint="Каждая попытка отправить уведомление — успешная или нет (хранится 30 дней)" flush>
      {!q.data ? (
        <div style={{ padding: 20 }}>
          <Skeleton height={80} />
        </div>
      ) : q.data.deliveries.length === 0 ? (
        <Empty title="Уведомления ещё не отправлялись" icon="send" />
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Время</th>
                <th>Канал</th>
                <th>Тип</th>
                <th>Результат</th>
              </tr>
            </thead>
            <tbody>
              {q.data.deliveries.map((d) => (
                <tr key={d.id}>
                  <td className={ui.num}>{dateTime(d.createdAt)}</td>
                  <td className={ui.cellMain}>{d.target}</td>
                  <td>
                    {KIND[d.kind]}
                    {d.alertId ? <span className={ui.cellSub}>алерт #{d.alertId}</span> : null}
                  </td>
                  <td>
                    {d.ok ? (
                      <StatusBadge status="healthy" label="Доставлено" />
                    ) : (
                      <StatusBadge status="critical" label={d.error ?? 'Ошибка'} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

export function AlertsPage() {
  const { can, user } = useSession()
  const [filters, setFilters] = useState<AlertFilterValue>({ severity: '', owner: '' })
  const [params, setParams] = useSearchParams()
  const [silencing, setSilencing] = useState<Alert | null>(null)
  const [noting, setNoting] = useState<Alert | null>(null)
  const counts = useQuery({ queryKey: ['counts'], queryFn: () => api.get<{ critical: number; warning: number }>('/overview/counts') })
  const firingCount = counts.data ? counts.data.critical + counts.data.warning : null
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'active', label: firingCount ? `Активные · ${firingCount}` : 'Активные' },
    { id: 'history', label: 'История' },
    { id: 'silences', label: 'Заглушки' },
    { id: 'rules', label: 'Правила' },
    ...(can('operator') ? [{ id: 'channels' as const, label: 'Каналы' }] : []),
    { id: 'deliveries', label: 'Доставка' },
  ]
  const raw = params.get('tab') as Tab | null
  const tab: Tab = raw && tabs.some((t) => t.id === raw) ? raw : 'active'
  const focus = Number(params.get('focus')) || null
  const listQuery = useQuery({
    queryKey: ['alerts', tab],
    queryFn: () => api.get<{ alerts: Alert[] }>(`/alerts?status=${tab === 'history' ? 'all' : 'firing'}&days=14`),
    enabled: tab === 'active' || tab === 'history' || tab === 'silences',
    refetchInterval: 15_000,
  })

  return (
    <>
      <PageHero
        eyebrow="Алерты"
        title="Что горит и куда сообщаем"
        lead="Критичные алерты открывают инцидент. Повторное уведомление — по правилу; «В работу» и «Тишина» его останавливают."
      />
      <Tabs label="Раздел алертов" value={tab} onChange={(v) => setParams(v === 'active' ? {} : { tab: v })} items={tabs} />
      {tab === 'rules' ? (
        <AlertRulesPanel />
      ) : tab === 'channels' ? (
        <ChannelsPanel />
      ) : tab === 'deliveries' ? (
        <DeliveriesPanel />
      ) : tab === 'silences' ? (
        <SilencesPanel alerts={listQuery.data?.alerts} />
      ) : listQuery.isError ? (
        <LoadError error={listQuery.error} onRetry={() => void listQuery.refetch()} />
      ) : (
        <Panel flush>
          {!listQuery.data ? (
            <div style={{ padding: 20 }}>
              <Skeleton height={120} />
            </div>
          ) : listQuery.data.alerts.length === 0 ? (
            <Empty title={tab === 'active' ? 'Активных алертов нет' : 'За 14 дней алертов не было'} />
          ) : (
            <>
              <AlertFilters value={filters} onChange={setFilters} alerts={listQuery.data.alerts} />
              <AlertsTable
                alerts={filterAlerts(listQuery.data.alerts, filters, user?.email ?? null)}
                focus={focus}
                history={tab === 'history'}
                onSilence={setSilencing}
                onNotes={setNoting}
              />
            </>
          )}
        </Panel>
      )}
      <SilenceDialog alert={silencing} onClose={() => setSilencing(null)} />
      <AlertNotesDialog alert={noting} onClose={() => setNoting(null)} />
    </>
  )
}
