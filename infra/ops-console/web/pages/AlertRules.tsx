import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { useAction } from '../lib/hooks'
import type { AgentSummary, AlertRule } from '../lib/types'
import { bizStreakText } from '../../shared/alert-streak'
import { BUSY_MAX_MS } from '../../shared/busy-limits'
import { SeverityBadge } from '../ui/Badge'
import { Button, Check, Dialog, Field, FormError, Input, Select } from '../ui/Controls'
import { Empty, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'

export const RULE_KIND_LABEL: Record<AlertRule['kind'], string> = {
  host_metric: 'Метрика хоста',
  container_down: 'Контейнер остановлен',
  container_unhealthy: 'Контейнер unhealthy',
  container_restarts: 'Restart loop',
  container_oom: 'Нехватка памяти (OOM)',
  agent_silent: 'Агент молчит',
  monitor_down: 'Сайт недоступен',
  tls_expiry: 'TLS истекает',
  deploy_failed: 'Деплой упал',
  deploy_slow: 'Деплой идёт долго',
  deploy_rollback_prev: 'Нет rollback-prev',
}

/** Правила, которые оцениваются по отчётам агентов (у остальных — мониторы, TLS, деплои — сервера нет). */
const PER_AGENT = new Set<AlertRule['kind']>(['host_metric', 'container_down', 'container_unhealthy', 'container_restarts', 'container_oom', 'agent_silent'])

const KNOWN_METRICS: Array<[string, string]> = [
  ['cpu_pct', 'CPU, %'],
  ['mem_pct', 'Память, %'],
  ['disk_pct', 'Диск (самый заполненный), %'],
  ['load1', 'Load average 1 мин'],
  ['swap_used_mb', 'Swap, МБ'],
  ['nginx_5xx_rpm', 'nginx 5xx в минуту'],
  ['nginx_4xx_rpm', 'nginx 4xx в минуту'],
  ['nginx_rpm', 'nginx запросов в минуту'],
  ['containers_running', 'Работающих контейнеров'],
  ['docker_ok', 'Docker отвечает агенту (1 / 0)'],
]

/** Как правило срабатывает — человеческими словами. */
export function ruleCondition(r: Pick<AlertRule, 'kind' | 'metric' | 'op' | 'threshold' | 'forSamples'>): string {
  const times = r.forSamples > 1 ? `, ${r.forSamples} раза подряд` : ''
  switch (r.kind) {
    case 'host_metric':
      // biz_* обновляется раз в 5 минут — порог в замерах, а не в отчётах.
      return `${r.metric ?? '?'} ${r.op === 'gt' ? '>' : '<'} ${r.threshold}${r.metric?.startsWith('biz_') ? bizStreakText(r.forSamples) : times}`
    case 'container_unhealthy':
      // Пакетные сервисы из списка при CPU не ниже порога считают задачу, а не висят: тихая отметка, не дольше потолка.
      return r.threshold > 0 && r.metric
        ? `healthcheck не проходит${times}; у ${r.metric.split(',').map((x) => x.trim()).filter(Boolean).join(', ')} — тревога, только если CPU ниже ${r.threshold}% (или неизвестен) либо тишина дольше ${BUSY_MAX_MS / 60_000} мин`
        : `healthcheck не проходит${times}`
    case 'container_restarts':
      return `≥ ${r.threshold} перезапусков демоном за 10 минут`
    case 'container_oom':
      return `≥ ${r.threshold} процессов убито ядром по нехватке памяти за 10 минут`
    case 'tls_expiry':
      return `до истечения < ${r.threshold} дней`
    case 'agent_silent':
      return 'нет отчётов дольше заданного числа интервалов (Настройки → Общие)'
    case 'monitor_down':
      return `${r.forSamples} неудачные проверки подряд`
    case 'deploy_failed':
      return 'скрипт деплоя завершился с ошибкой или запуск GitHub — failure / timed_out'
    case 'deploy_slow':
      return `деплой идёт дольше ${r.threshold} мин`
    case 'deploy_rollback_prev':
      return 'деплой сменил сервисам образ, а rollback-prev им не поставил'
    default:
      return r.forSamples > 1 ? `${r.forSamples} отчёта подряд` : 'с первого отчёта'
  }
}

type Draft = Omit<AlertRule, 'id' | 'builtin'>
const EMPTY: Draft = {
  name: '',
  kind: 'host_metric',
  agentId: null,
  metric: 'cpu_pct',
  op: 'gt',
  threshold: 80,
  forSamples: 3,
  severity: 'warning',
  repeatMin: 240,
  enabled: true,
}

function RuleDialog({
  rule,
  agents,
  agentId,
  onClose,
}: {
  rule: AlertRule | null | undefined
  agents: AgentSummary[]
  /** Новое правило со страницы хоста — сразу для этого сервера. */
  agentId?: string | null
  onClose: () => void
}) {
  const [d, setD] = useState<Draft>(EMPTY)
  useEffect(() => setD(rule ? { ...rule } : { ...EMPTY, agentId: agentId ?? null }), [rule, agentId])
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))
  const save = useAction(
    () => {
      const { kind, ...rest } = d
      return rule ? api.patch(`/alerts/rules/${rule.id}`, rest) : api.post('/alerts/rules', { ...rest, kind })
    },
    { success: rule ? 'Правило сохранено' : 'Правило создано', invalidate: [['rules']] },
  )
  const hasThreshold =
    d.kind === 'host_metric' ||
    d.kind === 'container_unhealthy' ||
    d.kind === 'container_restarts' ||
    d.kind === 'container_oom' ||
    d.kind === 'tls_expiry' ||
    d.kind === 'deploy_slow'
  return (
    <Dialog
      open={rule !== undefined}
      onClose={onClose}
      title={rule ? `Правило «${rule.name}»` : 'Новое правило'}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            busy={save.isPending}
            disabled={!d.name.trim()}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            Сохранить
          </Button>
        </>
      }
    >
      <div className={`${ui.formGrid} ${ui.formGrid2}`}>
        <Field label="Название" wide>
          <Input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="Например: Swap используется" />
        </Field>
        <Field label="Тип">
          <Select value={d.kind} disabled={Boolean(rule)} onChange={(e) => set('kind', e.target.value as Draft['kind'])}>
            {Object.entries(RULE_KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        {PER_AGENT.has(d.kind) ? (
          <Field label="Сервер" hint="Пусто — все серверы">
            <Select value={d.agentId ?? ''} onChange={(e) => set('agentId', e.target.value || null)}>
              <option value="">Все</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {d.kind === 'container_unhealthy' ? (
          <Field
            label="Пакетные сервисы"
            hint="Через запятую, сервисы compose. У них unhealthy при CPU не ниже порога — расчёт: тихая отметка в ленте, тревога — при простое или дольше 90 минут. Пусто — тревога при любом unhealthy"
          >
            <Input placeholder="diarization,whisper" value={d.metric ?? ''} onChange={(e) => set('metric', e.target.value.replace(/\s+/g, '').trim() || null)} />
          </Field>
        ) : null}
        {d.kind === 'host_metric' ? (
          <>
            <Field label="Метрика" hint="Бизнес-метрики агента — с префиксом biz_">
              <Input list="known-metrics" value={d.metric ?? ''} onChange={(e) => set('metric', e.target.value.trim() || null)} />
            </Field>
            <datalist id="known-metrics">
              {KNOWN_METRICS.map(([m, label]) => (
                <option key={m} value={m}>
                  {label}
                </option>
              ))}
            </datalist>
            <Field label="Условие">
              <Select value={d.op} onChange={(e) => set('op', e.target.value as Draft['op'])}>
                <option value="gt">больше порога</option>
                <option value="lt">меньше порога</option>
              </Select>
            </Field>
          </>
        ) : null}
        {hasThreshold ? (
          <Field
            label={
              d.kind === 'tls_expiry'
                ? 'Порог, дней'
                : d.kind === 'container_unhealthy'
                  ? 'Занят при CPU от, % ядра'
                  : d.kind === 'container_restarts'
                    ? 'Перезапусков за 10 мин'
                    : d.kind === 'container_oom'
                      ? 'Убито процессов за 10 мин'
                      : d.kind === 'deploy_slow'
                        ? 'Порог, минут'
                        : 'Порог'
            }
            hint={
              d.kind === 'container_unhealthy'
                ? 'Контейнер не отвечает на healthcheck, но CPU не ниже порога — он считает задачу: тихая отметка в ленте, без алерта. 0 — тревога при любом unhealthy'
                : undefined
            }
          >
            <Input type="number" step="any" value={d.threshold} onChange={(e) => set('threshold', Number(e.target.value))} />
          </Field>
        ) : null}
        <Field
          label="Подряд, раз"
          hint={
            d.kind === 'host_metric' && d.metric?.startsWith('biz_')
              ? 'Замеров подряд за порогом: бизнес-метрика меряется раз в BUSINESS_INTERVAL_SEC (5 мин), повторы в отчётах не считаются'
              : 'Против дребезга: сколько отчётов/проверок подряд за порогом'
          }
        >
          <Input type="number" min={1} max={60} value={d.forSamples} onChange={(e) => set('forSamples', Number(e.target.value))} />
        </Field>
        <Field label="Важность">
          <Select value={d.severity} onChange={(e) => set('severity', e.target.value as Draft['severity'])}>
            <option value="warning">Внимание</option>
            <option value="critical">Критично (открывает инцидент)</option>
          </Select>
        </Field>
        <Field label="Повтор уведомления, мин" hint="0 — не повторять">
          <Input type="number" min={0} max={10080} value={d.repeatMin} onChange={(e) => set('repeatMin', Number(e.target.value))} />
        </Field>
        <Check label="Включено" checked={d.enabled} onChange={(v) => set('enabled', v)} />
      </div>
      <FormError error={save.error} />
    </Dialog>
  )
}

export function AlertRulesPanel() {
  const { can } = useSession()
  const [params, setParams] = useSearchParams()
  /** ?agent=<id> — со страницы хоста: только правила, действующие на этот сервер. */
  const forAgent = params.get('agent')
  const [editing, setEditing] = useState<AlertRule | null | undefined>(undefined)
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api.get<{ rules: AlertRule[] }>('/alerts/rules') })
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.get<{ agents: AgentSummary[] }>('/infra/agents') })
  const toggle = useAction((r: AlertRule) => api.patch(`/alerts/rules/${r.id}`, { enabled: !r.enabled }), {
    success: 'Правило обновлено',
    invalidate: [['rules'], ['alerts']],
  })
  const remove = useAction((r: AlertRule) => api.del(`/alerts/rules/${r.id}`), {
    success: 'Правило удалено',
    invalidate: [['rules'], ['alerts']],
  })
  const agentName = (id: string | null) => (id ? (agents.data?.agents.find((a) => a.id === id)?.name ?? id) : 'Все серверы')
  return (
    <Panel
      title="Правила"
      hint={
        forAgent ? (
          <>
            Правила, действующие на сервер «{agentName(forAgent)}» (общие и его собственные).{' '}
            <button type="button" className={ui.linkButton} onClick={() => setParams({ tab: 'rules' })}>
              Показать все
            </button>
          </>
        ) : (
          'Встроенные правила можно менять и выключать, но не удалять. Выключение закрывает горящие по правилу алерты.'
        )
      }
      action={
        can('operator') ? (
          <Button variant="primary" small icon="plus" onClick={() => setEditing(null)}>
            Правило
          </Button>
        ) : null
      }
      flush
    >
      {!rules.data ? (
        <div style={{ padding: 20 }}>
          <Skeleton height={140} />
        </div>
      ) : rules.data.rules.length === 0 ? (
        <Empty title="Правил нет" icon="bell" />
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Правило</th>
                <th>Условие</th>
                <th>Важность</th>
                <th>Повтор</th>
                <th>Вкл.</th>
                {can('operator') ? <th aria-label="Действия" /> : null}
              </tr>
            </thead>
            <tbody>
              {rules.data.rules
                .filter((r) => !forAgent || !PER_AGENT.has(r.kind) || r.agentId === null || r.agentId === forAgent)
                .map((r) => (
                <tr key={r.id} style={r.enabled ? undefined : { opacity: 0.6 }}>
                  <td>
                    <span className={ui.cellMain}>{r.name}</span>
                    <span className={ui.cellSub}>
                      {RULE_KIND_LABEL[r.kind]}
                      {PER_AGENT.has(r.kind) ? ` · ${agentName(r.agentId)}` : ''}
                      {r.builtin ? ' · встроенное' : ''}
                    </span>
                  </td>
                  <td className={ui.small}>{ruleCondition(r)}</td>
                  <td>
                    <SeverityBadge severity={r.severity} />
                  </td>
                  <td className={ui.num}>{r.repeatMin ? `${r.repeatMin} мин` : 'нет'}</td>
                  <td>
                    <Check
                      label={<span className="visually-hidden">Включено: {r.name}</span>}
                      checked={r.enabled}
                      disabled={!can('operator') || toggle.isPending}
                      onChange={() => toggle.mutate(r)}
                    />
                  </td>
                  {can('operator') ? (
                    <td>
                      <div className={s.actionsCell}>
                        <Button small onClick={() => setEditing(r)}>
                          Изменить
                        </Button>
                        {!r.builtin ? (
                          <Button
                            small
                            variant="ghost"
                            onClick={() => {
                              if (window.confirm(`Удалить правило «${r.name}»?`)) remove.mutate(r)
                            }}
                          >
                            Удалить
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RuleDialog rule={editing} agents={agents.data?.agents ?? []} agentId={forAgent} onClose={() => setEditing(undefined)} />
    </Panel>
  )
}
