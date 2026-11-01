import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { cx } from './Glass'
import s from './styles'

interface ToastItem {
  id: number
  text: string
  error: boolean
}

const ToastContext = createContext<(text: string, error?: boolean) => void>(() => undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random()
    setItems((xs) => [...xs.slice(-3), { id, text, error }])
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), error ? 7000 : 4000)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className={s.toastHost} role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx(s.toast, t.error && s.toastError)}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
