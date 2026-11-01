import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { Link } from 'react-router-dom'
import { Icon, type IconName } from './Icon'
import { cx } from './Glass'
import s from './styles'

type Variant = 'primary' | 'glass' | 'ghost' | 'danger'
const VARIANT: Record<Variant, string | undefined> = { primary: s.btnPrimary, glass: undefined, ghost: s.btnGhost, danger: s.btnDanger }

export function Button({
  variant = 'glass',
  small,
  icon,
  iconOnly,
  busy,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean; icon?: IconName; iconOnly?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={cx(s.btn, VARIANT[variant], small && s.btnSmall, iconOnly && s.btnIcon, className)}
    >
      {icon ? <Icon name={busy ? 'refresh' : icon} size={small ? 15 : 17} /> : null}
      {iconOnly ? <span className="visually-hidden">{children}</span> : children}
    </button>
  )
}

export function LinkButton({
  to,
  variant = 'glass',
  small,
  icon,
  children,
}: {
  to: string
  variant?: Variant
  small?: boolean
  icon?: IconName
  children: ReactNode
}) {
  return (
    <Link to={to} className={cx(s.btn, VARIANT[variant], small && s.btnSmall)}>
      {icon ? <Icon name={icon} size={small ? 15 : 17} /> : null}
      {children}
    </Link>
  )
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={cx(s.field, wide && s.span2)}>
      <span className={s.label}>{label}</span>
      {children}
      {hint ? <span className={s.hint}>{hint}</span> : null}
    </label>
  )
}

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(s.input, p.className)} />
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(s.select, p.className)} />
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(s.textarea, p.className)} />

export function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className={s.check}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

/** Нативный <dialog> в модальном режиме: фокус-ловушка, Esc и возврат фокуса — браузером. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  dismissible = true,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  actions?: ReactNode
  /** false — не закрывается по Esc и клику мимо (показ одноразового секрета): только кнопкой. */
  dismissible?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-labelledby="dialog-title"
      onClose={onClose}
      onCancel={(e) => {
        if (!dismissible) e.preventDefault()
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose()
      }}
    >
      {open ? (
        <div className={s.dialogBody}>
          <h2 className={s.dialogTitle} id="dialog-title">
            {title}
          </h2>
          {children}
          {actions ? <div className={s.dialogActions}>{actions}</div> : null}
        </div>
      ) : null}
    </dialog>
  )
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T
  onChange: (v: T) => void
  items: Array<{ id: T; label: ReactNode }>
  label: string
}) {
  return (
    <div className={s.tabs} role="tablist" aria-label={label}>
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" aria-selected={it.id === value} className={s.tab} onClick={() => onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <div className={s.formError} role="alert">
      {error instanceof Error ? error.message : String(error)}
    </div>
  )
}
