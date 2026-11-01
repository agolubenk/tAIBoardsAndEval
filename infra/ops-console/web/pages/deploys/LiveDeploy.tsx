import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { dateTime, preciseDuration } from '../../lib/format'
import type { DeployCard, DeployLiveResponse } from '../../../shared/deploy-events-contract'
import { StatusBadge } from '../../ui/Badge'
import { Empty, LoadError, Panel, Skeleton, cx } from '../../ui/Glass'
import { Icon } from '../../ui/Icon'
import ui from '../../ui/styles'
import s from './deploys.module.css'
import { CHECK_LABEL, PHASE_LABEL, checkBadge, deployBadge, failedPhase, liveMs, phaseBadge, rollbackSummary } from './deployLive'

/** Секундомер для тикающих длительностей: пока деплой идёт — раз в секунду, иначе стоит. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active])
  return now
}

const dur = (ms: number | null) => (ms === null ? '—' : preciseDuration(0, ms))
const safeHref = (url: string | undefined) => (url && url.startsWith('https://') ? url : undefined)

/**
 * Живая карточка текущего или последнего деплоя из событий contabo-deploy.sh. Опрос — раз в 5 с, только пока
 * деплой идёт; иначе раз в минуту, чтобы заметить новый (в фоновой вкладке react-query не опрашивает).
 */
export function LiveDeploy() {
  const q = useQuery({
    queryKey: ['deploy-live'],
    queryFn: () => api.get<DeployLiveResponse>('/events/deploys/live'),
    refetchInterval: (query) => (query.state.data?.card?.status === 'running' ? 5_000 : 60_000),
  })
  const card = q.data?.card ?? null
  const running = card?.status === 'running'
  const now = useTicker(running)
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  if (!q.data) {
    return (
      <Panel>
        <Skeleton height={120} />
      </Panel>
    )
  }
  if (!card) {
    return (
      <Panel title="Ход деплоя">
        <Empty title="Событий деплоя ещё не было" icon="rocket">
          contabo-deploy.sh шлёт их под учёткой агента сервера: карточка появится с первым деплоем, когда агент подключён.
        </Empty>
      </Panel>
    )
  }
  return <DeployCardView card={card} sinceFetchMs={now - q.dataUpdatedAt} />
}

function DeployCardView({ card, sinceFetchMs }: { card: DeployCard; sinceFetchMs: number }) {
  const running = card.status === 'running'
  const [status, label] = deployBadge(card)
  const failed = failedPhase(card)
  const runUrl = safeHref(card.run?.url)
  const hint =
    card.status === 'stale'
      ? 'Событий нет дольше 2,5 ч или запуск GitHub завершился без итога от скрипта: деплой, скорее всего, прерван (убит раннер, перезагрузка сервера). Смотрите лог запуска.'
      : failed
        ? `Разбор — с фазы «${PHASE_LABEL[failed.key] ?? failed.key}»${failed.rc !== null ? ` (код ${failed.rc})` : ''}: её строки — в логе запуска GitHub.`
        : running
          ? 'Обновляется каждые 5 секунд, пока деплой идёт.'
          : undefined
  return (
    <Panel
      title={running ? 'Идёт деплой' : 'Последний деплой'}
      hint={hint}
      action={
        runUrl ? (
          <a className={s.runLink} href={runUrl} target="_blank" rel="noreferrer">
            Запуск в GitHub <Icon name="external" size={14} />
          </a>
        ) : null
      }
    >
      <div className={s.head}>
        <StatusBadge status={status} label={label} />
        <code className={s.sha} title={card.sha}>
          {card.sha.slice(0, 9)}
        </code>
        {card.run?.title ? <span className={s.title}>{card.run.title}</span> : null}
        <span className={cx(ui.small, ui.faint)}>
          {card.agentName} · старт {dateTime(card.startedAt)} ·{' '}
          <span className={s.num}>{dur(liveMs(card.durationMs, running, sinceFetchMs))}</span>
        </span>
      </div>

      <ol className={s.phases} aria-label="Фазы деплоя">
        {card.phases.map((p) => {
          const [st, text] = phaseBadge(p, card)
          return (
            <li key={p.key} className={cx(s.phase, s[`phase_${p.status}`], p.status === 'running' && !running && s.phase_stale)}>
              <span className={s.phaseName}>{PHASE_LABEL[p.key] ?? p.key}</span>
              <StatusBadge status={st} label={text} />
              <span className={cx(s.num, ui.faint)}>{dur(liveMs(p.durationMs, running && p.status === 'running', sinceFetchMs))}</span>
            </li>
          )
        })}
      </ol>

      <div className={s.details}>
        <section aria-label="Проверки по публичным адресам">
          <h3 className={s.subTitle}>Проверки снаружи</h3>
          {card.checks.length === 0 ? (
            <p className={cx(ui.small, ui.faint)}>{running ? 'Ещё не начинались.' : 'Не выполнялись.'}</p>
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Проверка</th>
                    <th>Адрес</th>
                    <th>Результат</th>
                    <th>Время</th>
                  </tr>
                </thead>
                <tbody>
                  {card.checks.map((c) => {
                    const [st, text] = checkBadge(c, card)
                    return (
                      <tr key={c.url}>
                        <td>{(c.key && CHECK_LABEL[c.key]) || c.key || '—'}</td>
                        <td className={s.url}>
                          <a className={ui.rowLink} href={c.url} target="_blank" rel="noreferrer">
                            {c.url.replace(/^https:\/\//, '')}
                          </a>
                        </td>
                        <td>
                          <StatusBadge status={st} label={text} />
                        </td>
                        <td className={ui.num}>{dur(liveMs(c.durationMs, running && c.status === 'running', sinceFetchMs))}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section aria-label="rollback-prev">
          <h3 className={s.subTitle}>Откат без пересборки</h3>
          <p className={ui.small}>rollback-prev: {rollbackSummary(card)}</p>
          <p className={cx(ui.small, ui.faint)}>
            События: получено {card.events.received} из {card.events.lastSeq}
            {card.events.missing.length ? ` (потеряны № ${card.events.missing.join(', ')} — карточку собрали следующие)` : ''}.
          </p>
        </section>
      </div>
    </Panel>
  )
}
