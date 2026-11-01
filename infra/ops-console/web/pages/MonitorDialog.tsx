import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useAction } from '../lib/hooks'
import type { Monitor } from '../lib/types'
import { Button, Check, Dialog, Field, FormError, Input, Select } from '../ui/Controls'
import ui from '../ui/styles'

type Draft = {
  name: string
  type: Monitor['type']
  url: string
  dnsRecord: Monitor['dnsRecord']
  expectValue: string
  description: string
  method: 'GET' | 'HEAD'
  expectStatus: string
  expectHealthJson: boolean
  keyword: string
  intervalSec: number
  timeoutMs: number
  tags: string
  enabled: boolean
  isPublic: boolean
}

const EMPTY: Draft = {
  name: '',
  type: 'http',
  url: 'https://',
  dnsRecord: 'A',
  expectValue: '',
  description: '',
  method: 'GET',
  expectStatus: '',
  expectHealthJson: false,
  keyword: '',
  intervalSec: 60,
  timeoutMs: 8000,
  tags: '',
  enabled: true,
  isPublic: false,
}

const toDraft = (m: Monitor): Draft => ({
  ...m,
  expectStatus: m.expectStatus ? String(m.expectStatus) : '',
  keyword: m.keyword ?? '',
  expectValue: m.expectValue ?? '',
})

const URL_PLACEHOLDER: Record<Draft['type'], string> = { http: 'https://', tcp: 'db.example.com:5432', dns: 'app.example.com' }

/** Создание и правка монитора (HTTP, TCP, DNS). `monitor === undefined` — диалог закрыт, `null` — новый. */
export function MonitorDialog({ monitor, onClose }: { monitor: Monitor | null | undefined; onClose: () => void }) {
  const [d, setD] = useState<Draft>(EMPTY)
  useEffect(() => setD(monitor ? toDraft(monitor) : EMPTY), [monitor])
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))
  const save = useAction(
    () => {
      const body = {
        ...d,
        expectStatus: d.expectStatus ? Number(d.expectStatus) : null,
        keyword: d.keyword || null,
        expectValue: d.expectValue || null,
      }
      return monitor ? api.patch(`/monitors/${monitor.id}`, body) : api.post('/monitors', body)
    },
    {
      success: monitor ? 'Монитор сохранён' : 'Монитор добавлен — первая проверка в течение минуты',
      invalidate: [['monitors'], ['overview']],
    },
  )
  return (
    <Dialog
      open={monitor !== undefined}
      onClose={onClose}
      title={monitor ? `Монитор «${monitor.name}»` : 'Новый монитор'}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            busy={save.isPending}
            disabled={!d.name.trim() || d.url.trim().length < (d.type === 'http' ? 10 : 3)}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            Сохранить
          </Button>
        </>
      }
    >
      <div className={`${ui.formGrid} ${ui.formGrid2}`}>
        <Field label="Название" wide>
          <Input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="app.hrhelper.space — health" />
        </Field>
        <Field label="Тип проверки">
          <Select
            value={d.type}
            disabled={Boolean(monitor)}
            onChange={(e) => {
              const type = e.target.value as Draft['type']
              setD((x) => ({ ...x, type, url: x.url === URL_PLACEHOLDER[x.type] || !x.url ? URL_PLACEHOLDER[type] : x.url }))
            }}
          >
            <option value="http">HTTP(S) — сайт, health-эндпоинт</option>
            <option value="tcp">TCP — порт (база, Redis, SMTP)</option>
            <option value="dns">DNS — запись имени</option>
          </Select>
        </Field>
        <Field label="Подпись на странице статуса" hint="Например, «Веб-приложение и API»">
          <Input value={d.description} onChange={(e) => set('description', e.target.value)} maxLength={190} />
        </Field>
        <Field
          label={d.type === 'http' ? 'URL' : d.type === 'tcp' ? 'Хост:порт' : 'Имя хоста'}
          wide
          hint="Проверка идёт снаружи — с машины консоли; внутренние адреса — только из разрешённых в «Настройки → Общие»"
        >
          <Input
            type={d.type === 'http' ? 'url' : 'text'}
            value={d.url}
            placeholder={URL_PLACEHOLDER[d.type]}
            onChange={(e) => set('url', e.target.value)}
          />
        </Field>
        {d.type === 'dns' ? (
          <>
            <Field label="Запись">
              <Select value={d.dnsRecord} onChange={(e) => set('dnsRecord', e.target.value as Draft['dnsRecord'])}>
                {(['A', 'AAAA', 'CNAME', 'MX', 'TXT'] as const).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Ожидаемое значение" hint="Подстрока ответа, например IP сервера; пусто — любой ответ">
              <Input value={d.expectValue} onChange={(e) => set('expectValue', e.target.value)} maxLength={200} />
            </Field>
          </>
        ) : null}
        {d.type === 'http' ? (
          <>
            <Field label="Метод">
              <Select value={d.method} onChange={(e) => set('method', e.target.value as Draft['method'])}>
                <option value="GET">GET</option>
                <option value="HEAD">HEAD</option>
              </Select>
            </Field>
            <Field label="Ожидаемый код" hint="Пусто — любой 2xx/3xx">
              <Input
                inputMode="numeric"
                value={d.expectStatus}
                onChange={(e) => set('expectStatus', e.target.value.replace(/\D/g, '').slice(0, 3))}
              />
            </Field>
          </>
        ) : null}
        <Field label="Интервал, сек">
          <Input type="number" min={30} max={3600} value={d.intervalSec} onChange={(e) => set('intervalSec', Number(e.target.value))} />
        </Field>
        <Field label="Таймаут, мс">
          <Input
            type="number"
            min={1000}
            max={30000}
            step={500}
            value={d.timeoutMs}
            onChange={(e) => set('timeoutMs', Number(e.target.value))}
          />
        </Field>
        {d.type === 'http' ? (
          <Field label="Ключевая строка в ответе" wide hint="Например, название продукта в <title> — ловит «200, но не та страница»">
            <Input value={d.keyword} onChange={(e) => set('keyword', e.target.value)} />
          </Field>
        ) : null}
        <div className={ui.stack}>
          {d.type === 'http' ? (
            <Check
              label='Тело — JSON со status: "ok" (health-эндпоинт)'
              checked={d.expectHealthJson}
              onChange={(v) => set('expectHealthJson', v)}
            />
          ) : null}
          <Check label="Показывать на публичной status-странице" checked={d.isPublic} onChange={(v) => set('isPublic', v)} />
          <Check label="Включён" checked={d.enabled} onChange={(v) => set('enabled', v)} />
        </div>
      </div>
      <FormError error={save.error} />
    </Dialog>
  )
}
