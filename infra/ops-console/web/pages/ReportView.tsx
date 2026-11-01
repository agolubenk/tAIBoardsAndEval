import type { OpsReport } from '../../shared/report-contract'
import { dateTime, pct, timeShort } from '../lib/format'
import type { UiStatus } from '../lib/types'
import { SeverityBadge, StatusBadge } from '../ui/Badge'
import { Empty } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'

const OVERALL: Record<OpsReport['summary']['status'], UiStatus> = { healthy: 'healthy', degraded: 'warning', critical: 'critical' }

/** Отчёт `hrh.ops.report/v1` глазами человека — тот же JSON, что получит ИИ-совет. */
export function ReportView({ report }: { report: OpsReport }) {
  const r = report
  return (
    <div className={ui.stack} style={{ gap: 18 }}>
      <div className={ui.stack}>
        <div className={ui.row}>
          <StatusBadge status={OVERALL[r.summary.status]} label={r.summary.headline} />
          <span className={ui.small}>
            {r.period.kind === 'daily' ? 'Сутки' : 'Неделя'}: {dateTime(Date.parse(r.period.start))} — {dateTime(Date.parse(r.period.end))}
          </span>
        </div>
        <ul className={ui.small} style={{ margin: 0, paddingLeft: 18 }}>
          {r.summary.highlights.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      </div>

      <section className={ui.stack}>
        <h3 className={ui.panelTitle}>Рекомендации</h3>
        {r.recommendations.length ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {r.recommendations.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ) : (
          <p className={ui.muted}>По фактам периода действий не требуется.</p>
        )}
      </section>

      <section className={ui.stack}>
        <h3 className={ui.panelTitle}>Доступность</h3>
        {r.availability.length ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Сервис</th>
                  <th>Доступность</th>
                  <th>Проверок</th>
                  <th>Средняя задержка</th>
                </tr>
              </thead>
              <tbody>
                {r.availability.map((a) => (
                  <tr key={a.monitor}>
                    <td className={ui.cellMain}>{a.monitor}</td>
                    <td className={ui.num}>{pct(a.uptimePct, 2)}</td>
                    <td className={ui.num}>{a.checks}</td>
                    <td className={ui.num}>{a.avgLatencyMs !== null ? `${a.avgLatencyMs} мс` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={ui.muted}>Мониторов нет.</p>
        )}
      </section>

      <div className={s.grid2}>
        <section className={ui.stack}>
          <h3 className={ui.panelTitle}>Инциденты ({r.incidents.length})</h3>
          {r.incidents.length ? (
            <ul className={s.feed}>
              {r.incidents.map((i) => (
                <li key={i.id} className={s.feedItem}>
                  <span className={s.feedTime}>#{i.id}</span>
                  <span>
                    <SeverityBadge severity={i.severity} /> {i.title}
                    <span className={s.feedActor}> · {i.durationMin !== null ? `${i.durationMin} мин` : 'не закрыт'}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="Инцидентов не было" />
          )}
        </section>
        <section className={ui.stack}>
          <h3 className={ui.panelTitle}>Ручные перезапуски ({r.restarts.length})</h3>
          {r.restarts.length ? (
            <ul className={s.feed}>
              {r.restarts.map((x) => (
                <li key={`${x.at}-${x.container}`} className={s.feedItem}>
                  <span className={s.feedTime} title={dateTime(Date.parse(x.at))}>
                    {timeShort(Date.parse(x.at), Date.parse(r.generatedAt))}
                  </span>
                  <span>
                    <strong>{x.container}</strong> на {x.agent} — {x.result}
                    <span className={s.feedActor}>
                      {' '}
                      · {x.by}: {x.reason}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="Перезапусков не было" icon="restart" />
          )}
        </section>
      </div>

      <section className={ui.stack}>
        <h3 className={ui.panelTitle}>Серверы</h3>
        {r.hosts.length ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Сервер</th>
                  <th>CPU ср. / макс.</th>
                  <th>Память ср.</th>
                  <th>Диск макс.</th>
                  <th>Не работают</th>
                </tr>
              </thead>
              <tbody>
                {r.hosts.map((h) => (
                  <tr key={h.agent}>
                    <td className={ui.cellMain}>{h.name}</td>
                    <td className={ui.num}>
                      {pct(h.cpuAvgPct)} / {pct(h.cpuMaxPct)}
                    </td>
                    <td className={ui.num}>{pct(h.memAvgPct)}</td>
                    <td className={ui.num}>{pct(h.diskMaxPct)}</td>
                    <td>{h.containersNotRunning.length ? h.containersNotRunning.join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={ui.muted}>Серверы не подключены.</p>
        )}
      </section>

      <div className={s.grid2}>
        <section className={ui.stack}>
          <h3 className={ui.panelTitle}>Алерты</h3>
          <p className={ui.small}>
            Сработало: {r.alerts.fired} (критичных {r.alerts.critical}, предупреждений {r.alerts.warning}). Открыто сейчас:{' '}
            {r.alerts.stillOpen.length}.
          </p>
          {r.alerts.stillOpen.map((a) => (
            <span key={`${a.title}-${a.object}`} className={ui.small}>
              · {a.title} — {a.object}
            </span>
          ))}
        </section>
        <section className={ui.stack}>
          <h3 className={ui.panelTitle}>Деплои и TLS</h3>
          <p className={ui.small}>
            Деплоев: {r.deploys.total}, упавших: {r.deploys.failed}.
          </p>
          {r.tls.map((t) => (
            <span key={t.domain} className={ui.small}>
              · {t.domain}: {t.error ? t.error : `${t.daysLeft} дн.`}
            </span>
          ))}
        </section>
      </div>

      <details className={ui.small}>
        <summary style={{ cursor: 'pointer' }}>JSON для ИИ-совета ({r.schema})</summary>
        <pre className={ui.pre} style={{ maxHeight: 360, overflow: 'auto' }}>
          {JSON.stringify(r, null, 2)}
        </pre>
      </details>
    </div>
  )
}
