/** Настройки → «Общие»: имя консоли, хранение данных, публичная страница, исходящие адреса, пульс. */
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useAction } from '../../lib/hooks'
import { fullDateTime, timeAgo } from '../../lib/format'
import { Button, Check, Field, FormError, Input } from '../../ui/Controls'
import { Panel } from '../../ui/Glass'
import ui from '../../ui/styles'
import s from '../pages.module.css'
import type { GeneralSettings, SettingsResponse } from '../settingsTypes'

export function GeneralForm({ data }: { data: SettingsResponse }) {
  const { can } = useSession()
  const owner = can('owner')
  const [d, setD] = useState<GeneralSettings>(data.general)
  useEffect(() => setD(data.general), [data.general])
  const set = <K extends keyof GeneralSettings>(k: K, v: GeneralSettings[K]) => setD((x) => ({ ...x, [k]: v }))
  const save = useAction(() => api.put('/settings/general', d), {
    success: 'Настройки сохранены',
    invalidate: [['settings'], ['overview']],
  })
  const rt = data.runtime
  return (
    <div className={s.split}>
      <Panel title="Общие">
        <div className={`${ui.formGrid} ${ui.formGrid2}`}>
          <Field label="Название консоли" wide>
            <Input value={d.consoleName} disabled={!owner} onChange={(e) => set('consoleName', e.target.value)} />
          </Field>
          <Field label="Агент «молчит» после, интервалов" hint="× период отчётов агента (по умолчанию 4 × 15 с = 1 мин)">
            <Input
              type="number"
              min={2}
              max={40}
              disabled={!owner}
              value={d.agentSilentAfterIntervals}
              onChange={(e) => set('agentSilentAfterIntervals', Number(e.target.value))}
            />
          </Field>
          <Field label="Пауза между перезапусками, сек" hint="Один контейнер не чаще; у агента на хосте — своя пауза">
            <Input
              type="number"
              min={30}
              max={3600}
              disabled={!owner}
              value={d.restartCooldownSec}
              onChange={(e) => set('restartCooldownSec', Number(e.target.value))}
            />
          </Field>
          <Field
            label="Внутренние адреса"
            wide
            hint="Хосты или IP через запятую, куда разрешены мониторы, webhook и отчёты, например «127.0.0.1, localhost». Пусто — только публичные адреса (защита от SSRF)."
          >
            <Input
              value={d.privateEgressHosts}
              disabled={!owner}
              onChange={(e) => set('privateEgressHosts', e.target.value)}
              placeholder="не разрешены"
            />
          </Field>
          <Field label="Часовой пояс уведомлений" hint="Время «с 15:03» в Telegram и почте, например Europe/Minsk">
            <Input value={d.timezone} disabled={!owner} onChange={(e) => set('timezone', e.target.value)} placeholder="Europe/Minsk" />
          </Field>
          <Field
            label="Внешний пульс (dead man's switch)"
            hint="URL healthchecks.io и т. п.: консоль пингует его раз в минуту. Пропал пинг — сервис сам пришлёт тревогу: консоль не может сообщить о собственном падении."
          >
            <Input
              value={d.heartbeatUrl}
              disabled={!owner}
              onChange={(e) => set('heartbeatUrl', e.target.value)}
              placeholder="https://hc-ping.com/…"
            />
          </Field>
          <Field label="Хранить проверки, дней">
            <Input
              type="number"
              min={1}
              max={90}
              disabled={!owner}
              value={d.checkRetentionDays}
              onChange={(e) => set('checkRetentionDays', Number(e.target.value))}
            />
          </Field>
          <Field label="Хранить метрики, дней">
            <Input
              type="number"
              min={1}
              max={90}
              disabled={!owner}
              value={d.metricRetentionDays}
              onChange={(e) => set('metricRetentionDays', Number(e.target.value))}
            />
          </Field>
          <Field label="Хранить ленту событий, дней" hint="7–365; журнал действий и входов">
            <Input
              type="number"
              min={7}
              max={365}
              disabled={!owner}
              value={d.activityRetentionDays}
              onChange={(e) => set('activityRetentionDays', Number(e.target.value))}
            />
          </Field>
          <Field label="Хранить журнал доставки, дней" hint="7–180">
            <Input
              type="number"
              min={7}
              max={180}
              disabled={!owner}
              value={d.deliveryRetentionDays}
              onChange={(e) => set('deliveryRetentionDays', Number(e.target.value))}
            />
          </Field>
          <Field label="Хранить суточную доступность, дней" hint="90–730; страница статуса показывает 90 дней">
            <Input
              type="number"
              min={90}
              max={730}
              disabled={!owner}
              value={d.rollupRetentionDays}
              onChange={(e) => set('rollupRetentionDays', Number(e.target.value))}
            />
          </Field>
          <Check
            label="Публичная status-страница (/status)"
            checked={d.publicStatusEnabled}
            disabled={!owner}
            onChange={(v) => set('publicStatusEnabled', v)}
          />
          <Field label="Заголовок публичной страницы">
            <Input
              value={d.publicStatusTitle}
              disabled={!owner || !d.publicStatusEnabled}
              onChange={(e) => set('publicStatusTitle', e.target.value)}
            />
          </Field>
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
      <Panel title="Среда выполнения" hint="Из переменных окружения консоли — меняются только при деплое">
        <dl className={ui.kv}>
          <dt>Адрес</dt>
          <dd>{rt.publicUrl}</dd>
          <dt>База</dt>
          <dd>{rt.database}</dd>
          <dt>Планировщик</dt>
          <dd>{rt.scheduler}</dd>
          <dt>Внешний cron</dt>
          <dd>{rt.cronConfigured ? 'OPS_CRON_SECRET задан' : 'не настроен'}</dd>
          <dt>Последний тик</dt>
          <dd>{rt.lastTickAt ? `${timeAgo(rt.lastTickAt)} (${fullDateTime(rt.lastTickAt)})` : 'ещё не было'}</dd>
        </dl>
      </Panel>
    </div>
  )
}
