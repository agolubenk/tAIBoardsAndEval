/**
 * Telegram — общее для профиля (личная подписка) и панели бота (владелец): типы ответа API,
 * статусы, шаги привязки (ссылка, QR, подтверждение), колонка «Telegram» в списке пользователей.
 * Профиль — TelegramProfile.tsx, бот консоли с паролем — TelegramBotPanel.tsx.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { timeAgo } from '../lib/format'
import type { UiStatus } from '../lib/types'
import { Button, Dialog } from '../ui/Controls'
import ui from '../ui/styles'
import s from './pages.module.css'


export type TgStatus = 'awaiting_password' | 'active' | 'reconfirm' | 'suspended'

export interface TgSubscription {
  id: number
  userId: number
  username: string
  displayName: string
  status: TgStatus
  minSeverity: 'warning' | 'critical'
  digest: boolean
  linkedAt: number
  activatedAt: number | null
  suspendedAt: number | null
  suspendedReason: string | null
  suspendedBy: string | null
  ownerLock: boolean
  lastDeliveryAt: number | null
  lastError: string | null
  otherBot: boolean
}

export interface MeResponse {
  bot: { username: string; passwordSet: boolean; accepting: boolean; viaApp: boolean } | null
  subscription: TgSubscription | null
  pending: { stage: 'link' | 'code'; expiresAt: number; telegram: string | null } | null
}

export interface BotResponse {
  mode: 'webhook' | 'polling'
  bot: {
    username: string
    webhookUrl: string
    passwordSet: boolean
    passwordVersion: number
    passwordChangedAt: number | null
    passwordChangedBy: string | null
    frozenReason: string | null
    frozenAt: number | null
    lastCheckAt: number | null
    lastError: string | null
    pendingUpdates: number
  } | null
  subscriptions: Array<TgSubscription & { email: string; name: string; userDisabled: boolean }>
  confirmed: number
}

export const TG_STATUS: Record<TgStatus, [UiStatus, string]> = {
  active: ['healthy', 'Подключено'],
  awaiting_password: ['pending', 'Ждёт пароль'],
  reconfirm: ['warning', 'Ждёт новый пароль'],
  suspended: ['unknown', 'Приостановлено'],
}

export const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

export function suspendedLine(sub: TgSubscription): string {
  const by = sub.suspendedBy === 'self' ? 'вами' : sub.suspendedBy === 'system' ? 'автоматически' : sub.suspendedBy ?? ''
  return `${sub.suspendedReason ?? 'приостановлено'}${by ? ` (${by})` : ''}${sub.suspendedAt ? `, ${timeAgo(sub.suspendedAt)}` : ''}`
}

/** Сгенерированный пароль — группами по 4: его вводят руками с телефона (бот сравнивает без пробелов). */
export const grouped = (p: string) => p.replace(/(.{4})(?=.)/g, '$1 ')

/** QR — только на широком экране: телефон не сканирует собственный экран. */
export function LinkQr({ url }: { url: string }) {
  const [cells, setCells] = useState<{ n: number; dark: Array<[number, number]> } | null>(null)
  useEffect(() => {
    let alive = true
    void import('qrcode-generator').then(({ default: qrcode }) => {
      const qr = qrcode(0, 'M')
      qr.addData(url)
      qr.make()
      const n = qr.getModuleCount()
      const dark: Array<[number, number]> = []
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark.push([c, r])
      if (alive) setCells({ n, dark })
    })
    return () => {
      alive = false
    }
  }, [url])
  if (!cells) return null
  const size = cells.n + 4
  return (
    <svg className={s.tgQr} viewBox={`-2 -2 ${size} ${size}`} role="img" aria-label="QR-код ссылки на бота" shapeRendering="crispEdges">
      <rect x={-2} y={-2} width={size} height={size} fill="#fff" />
      {cells.dark.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#000" />
      ))}
    </svg>
  )
}

/** Шаг «откройте бота»: кнопка (телефон) и QR (компьютер), срок ссылки, отмена. */
export function LinkStep({ link, lead, onCancel }: { link: { url: string; expiresAt: number }; lead: ReactNode; onCancel: () => void }) {
  const wide = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 720px)').matches, [])
  return (
    <div className={s.tgStep}>
      <p>
        {lead} Ссылка одноразовая, действует до {hhmm(link.expiresAt)}.
      </p>
      <div className={s.tgLinkRow}>
        <a className={`${ui.btn} ${ui.btnPrimary}`} href={link.url} target="_blank" rel="noreferrer noopener">
          Открыть Telegram
        </a>
        {wide ? <LinkQr url={link.url} /> : null}
        <Button variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </div>
  )
}

/** Подтверждение необратимого действия. */
export function Confirm({
  open,
  title,
  text,
  action,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  text: ReactNode
  action: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="danger" busy={busy} onClick={onConfirm}>
            {action}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{text}</p>
    </Dialog>
  )
}

export function useTelegramByUser(): { ready: boolean; byUser: Map<number, TgSubscription> } {
  const q = useQuery({ queryKey: ['telegram-bot'], queryFn: () => api.get<BotResponse>('/telegram/bot') })
  return useMemo(() => ({ ready: Boolean(q.data), byUser: new Map((q.data?.subscriptions ?? []).map((x) => [x.userId, x])) }), [q.data])
}

export function TelegramCell({ ready, sub }: { ready: boolean; sub: TgSubscription | undefined }) {
  if (!ready) return <span className={ui.cellSub}>—</span>
  if (!sub) return <span className={ui.cellSub}>не подключён</span>
  return (
    <>
      <span className={ui.cellMain}>{sub.username ? `@${sub.username}` : sub.displayName || 'подключён'}</span>
      <span className={ui.cellSub}>{TG_STATUS[sub.status][1]}</span>
    </>
  )
}
