import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { OpsReport } from '../../shared/report-contract'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { useAction } from '../lib/hooks'
import { dateTime, fullDateTime } from '../lib/format'
import type { UiStatus } from '../lib/types'
import { StatusBadge } from '../ui/Badge'
import { Button, Check, Field, FormError, Input, Select, Tabs } from '../ui/Controls'
import { Empty, LoadError, PageHero, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'
import { ReportView } from './ReportView'
import type { SettingsResponse } from './settingsTypes'

interface ReportRow {
  id: number
  period: 'daily' | 'weekly'
  periodStart: number
  periodEnd: number
  deliveryStatus: 'pending' | 'not_configured' | 'sent' | 'failed'
  deliveryError: string | null
  createdBy: string
  createdAt: number
}

const DELIVERY: Record<ReportRow['deliveryStatus'], [UiStatus, string]> = {
  sent: ['healthy', 'Отправлен совету'],
  pending: ['pending', 'Отправляется'],
  failed: ['critical', 'Не доставлен — повторим'],
  not_configured: ['pending', 'Сохранён, приёмник не задан'],
}

const RECEIVER_TEXT: Record<SettingsResponse['reports']['receiver'], string> = {
  product: 'Приёмник: продукт — автоматически. Связка та же, что у входа через платформу: адрес и ключ задавать не нужно.',
  manual: 'Приёмник: свой адрес ниже, отчёт подписывается указанным ключом.',
  none: 'Приёмника нет: отчёты собираются и хранятся здесь. Связка с продуктом появится вместе с входом через платформу.',
  broken:
    'Свой приёмник не работает: ключ не расшифровывается — скорее всего, сменился ключ шифрования консоли. Задайте адрес и ключ заново или очистите адрес — тогда отчёты пойдут в продукт по связке.',
}

function ScheduleForm({ settings }: { settings: SettingsResponse['reports'] }) {
  const { can } = useSession()
  const owner = can('owner')
  const [d, setD] = useState({ ...settings, secret: '' })
  useEffect(() => setD({ ...settings, secret: '' }), [settings])
  const save = useAction(
    () =>
      api.put('/settings/reports', {
        enabled: d.enabled,
        period: d.period,
        hourUtc: d.hourUtc,
        destinationUrl: d.destinationUrl,
        secret: d.secret,
      }),
    { success: 'Расписание сохранено', invalidate: [['settings']] },
  )
  return (
    <Panel
      title="Расписание и приёмник"
      hint="Сводка за период — доступность, инциденты, алерты, перезапуски, деплои, нагрузка — уходит ИИ-совету директоров продукта. Не дошедший отчёт отправляется повторно раз в 15 минут."
    >
      <p className={ui.small} style={{ marginTop: 0 }}>
        {RECEIVER_TEXT[settings.receiver]}
      </p>
      <div className={`${ui.formGrid} ${ui.formGrid2}`}>
        <Check label="Отправлять по расписанию" checked={d.enabled} disabled={!owner} onChange={(v) => setD({ ...d, enabled: v })} />
        <span />
        <Field label="Период">
          <Select value={d.period} disabled={!owner} onChange={(e) => setD({ ...d, period: e.target.value as 'daily' | 'weekly' })}>
            <option value="daily">Ежедневно</option>
            <option value="weekly">Еженедельно (понедельник)</option>
          </Select>
        </Field>
        <Field label="Час отправки, UTC" hint={`Сейчас по UTC ${new Date().getUTCHours()}:00`}>
          <Input
            type="number"
            min={0}
            max={23}
            disabled={!owner}
            value={d.hourUtc}
            onChange={(e) => setD({ ...d, hourUtc: Number(e.target.value) })}
          />
        </Field>
        <Field
          label="Свой приёмник (необязательно)"
          wide
          hint="Пусто — в продукт по связке входа через платформу. Свой адрес работает только вместе с ключом подписи: X-Ops-Signature = sha256=HMAC(ключ, «timestamp.body»)."
        >
          <Input
            type="url"
            disabled={!owner}
            value={d.destinationUrl}
            placeholder="https://app.hrhelper.space/api/v1/…"
            onChange={(e) => setD({ ...d, destinationUrl: e.target.value })}
          />
        </Field>
        {owner ? (
          <Field
            label="Ключ подписи"
            wide
            hint={settings.secretMask ? `Сейчас: ${settings.secretMask}. Пусто — оставить.` : 'Общий секрет с приёмником'}
          >
            <Input type="password" autoComplete="new-password" value={d.secret} onChange={(e) => setD({ ...d, secret: e.target.value })} />
          </Field>
        ) : null}
      </div>
      <FormError error={save.error} />
      {owner ? (
        <div style={{ marginTop: 14 }}>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate(undefined)}>
            Сохранить
          </Button>
        </div>
      ) : null}
    </Panel>
  )
}

export function ReportsPage() {
  const { can } = useSession()
  const [period, setPeriod] = useState<'daily' | 'weekly'>('daily')
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/settings') })
  const history = useQuery({ queryKey: ['reports'], queryFn: () => api.get<{ reports: ReportRow[] }>('/reports') })
  const preview = useAction((p: 'daily' | 'weekly') => api.post<{ report: OpsReport }>('/reports/preview', { period: p }))
  const send = useAction(
    (p: 'daily' | 'weekly') => api.post<{ status: ReportRow['deliveryStatus']; error: string | null }>('/reports/send', { period: p }),
    {
      success: (r) =>
        r.status === 'sent'
          ? 'Отчёт отправлен ИИ-совету'
          : r.status === 'not_configured'
            ? 'Отчёт сохранён: приёмник не настроен'
            : `Не доставлен: ${r.error}. Повторим автоматически.`,
      invalidate: [['reports']],
    },
  )
  return (
    <>
      <PageHero
        eyebrow="Отчёты · hrh.ops.report/v1"
        title="Отчёты ИИ-совету директоров"
        lead="Факты за период: доступность, инциденты, алерты, перезапуски с причинами, ресурсы серверов, деплои, сертификаты и рекомендации по правилам. Продукт берёт из отчёта только числа и имена сервисов — для ИИ-совета."
        actions={
          <>
            <Tabs
              label="Период отчёта"
              value={period}
              onChange={setPeriod}
              items={[
                { id: 'daily', label: 'Сутки' },
                { id: 'weekly', label: 'Неделя' },
              ]}
            />
            <Button icon="report" busy={preview.isPending} onClick={() => preview.mutate(period)}>
              Собрать
            </Button>
            {can('operator') ? (
              <Button variant="primary" icon="send" busy={send.isPending} onClick={() => send.mutate(period)}>
                Отправить сейчас
              </Button>
            ) : null}
          </>
        }
      />
      {preview.data ? (
        <Panel title="Предпросмотр" hint={`Собран ${fullDateTime(Date.parse(preview.data.report.generatedAt))}`}>
          <ReportView report={preview.data.report} />
        </Panel>
      ) : null}
      <div className={s.split}>
        <Panel title="История" flush>
          {history.isError ? (
            <LoadError error={history.error} />
          ) : !history.data ? (
            <div style={{ padding: 20 }}>
              <Skeleton height={100} />
            </div>
          ) : history.data.reports.length === 0 ? (
            <Empty title="Отчётов ещё не было" icon="report">
              Нажмите «Собрать», чтобы посмотреть, что получит совет.
            </Empty>
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Период</th>
                    <th>Доставка</th>
                    <th>Кто</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.reports.map((r) => {
                    const [st, label] = DELIVERY[r.deliveryStatus]
                    return (
                      <tr key={r.id}>
                        <td>
                          <Link className={ui.rowLink} to={`/reports/${r.id}`}>
                            {r.period === 'daily' ? 'Сутки' : 'Неделя'} до {dateTime(r.periodEnd)}
                          </Link>
                        </td>
                        <td>
                          <StatusBadge status={st} label={r.deliveryError ? `${label}: ${r.deliveryError}` : label} />
                        </td>
                        <td>{r.createdBy}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        {settings.data ? <ScheduleForm settings={settings.data.reports} /> : <Skeleton height={240} />}
      </div>
    </>
  )
}

export function ReportPage() {
  const { id = '' } = useParams()
  const q = useQuery({
    queryKey: ['report', id],
    queryFn: () =>
      api.get<{ report: OpsReport; deliveryStatus: ReportRow['deliveryStatus']; deliveryError: string | null; createdAt: number }>(
        `/reports/${encodeURIComponent(id)}`,
      ),
  })
  if (q.isError) return <LoadError error={q.error} />
  if (!q.data) return <Skeleton height={300} />
  const [st, label] = DELIVERY[q.data.deliveryStatus]
  return (
    <>
      <p className={ui.small}>
        <Link to="/reports">Отчёты</Link> <span className={ui.faint}>/ #{id}</span>
      </p>
      <PageHero
        eyebrow={`Отчёт #${id} · ${fullDateTime(q.data.createdAt)}`}
        title={q.data.report.summary.headline}
        titleAside={<StatusBadge status={st} label={label} />}
        lead={q.data.deliveryError ?? undefined}
      />
      <Panel>
        <ReportView report={q.data.report} />
      </Panel>
    </>
  )
}
