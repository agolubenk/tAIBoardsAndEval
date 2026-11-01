import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon, type IconName } from './Icon'
import s from './styles'

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')
export { cx }

export function PageHero({
  eyebrow,
  title,
  titleAside,
  lead,
  actions,
}: {
  eyebrow: string
  title: ReactNode
  titleAside?: ReactNode
  lead?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className={s.hero}>
      <div className={s.heroText}>
        <span className={s.eyebrow}>
          <span className={s.eyebrowDot} aria-hidden />
          {eyebrow}
        </span>
        <div className={s.titleRow}>
          <h1 className={s.title}>{title}</h1>
          {titleAside}
        </div>
        {lead ? <p className={s.lead}>{lead}</p> : null}
      </div>
      {actions ? <div className={s.heroActions}>{actions}</div> : null}
    </header>
  )
}

export function Panel({
  title,
  hint,
  action,
  flush,
  compact,
  children,
  id,
}: {
  title?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  flush?: boolean
  compact?: boolean
  children?: ReactNode
  id?: string
}) {
  const headingId = id ? `${id}-title` : undefined
  return (
    <section
      className={cx(s.panel, flush && s.panelFlush, compact && s.panelCompact)}
      aria-labelledby={title ? headingId : undefined}
      id={id}
    >
      {title || action ? (
        <div className={s.panelHeader}>
          <div>
            {title ? (
              <h2 className={s.panelTitle} id={headingId}>
                {title}
              </h2>
            ) : null}
            {hint ? <p className={s.panelHint}>{hint}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export function StatTile({
  label,
  value,
  sub,
  icon,
  to,
  tone,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: IconName
  to?: string
  tone?: 'attention' | 'critical'
}) {
  const body = (
    <>
      <span className={s.statTop}>
        <span>{label}</span>
        {icon ? <Icon name={icon} size={16} /> : null}
      </span>
      <span className={s.statValue}>{value}</span>
      {sub ? <span className={s.statSub}>{sub}</span> : null}
    </>
  )
  const className = cx(s.panel, s.panelCompact, s.stat, tone === 'attention' && s.statAttention, tone === 'critical' && s.statCritical)
  return to ? (
    <Link to={to} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}

export function Meter({ value, label }: { value: number | null | undefined; label: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0))
  const tone = v >= 90 ? s.meterCritical : v >= 80 ? s.meterWarning : ''
  return (
    <div className={cx(s.meter, tone)} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)}>
      <div className={s.meterFill} style={{ width: `${v}%` }} />
    </div>
  )
}

export function Empty({ title, children, icon = 'check' }: { title: string; children?: ReactNode; icon?: IconName }) {
  return (
    <div className={s.empty}>
      <span className={s.emptyIcon}>
        <Icon name={icon} size={20} />
      </span>
      <span className={s.emptyTitle}>{title}</span>
      {children ? <span className={s.small}>{children}</span> : null}
    </div>
  )
}

export function Skeleton({ height = 18, width = '100%' }: { height?: number; width?: number | string }) {
  return <div className={s.skeleton} style={{ height, width }} aria-hidden />
}

export function LoadError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className={s.formError} role="alert">
      {error instanceof Error ? error.message : 'Не удалось загрузить данные'}
      {onRetry ? (
        <>
          {' '}
          <button type="button" className={cx(s.btn, s.btnSmall, s.btnGhost)} onClick={onRetry}>
            Повторить
          </button>
        </>
      ) : null}
    </div>
  )
}
