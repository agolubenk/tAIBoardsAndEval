export type Appearance = 'light' | 'dark' | 'system'

const KEY = 'ops-appearance'

export function readAppearance(): Appearance {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement
  if (a === 'system') root.removeAttribute('data-appearance')
  else root.setAttribute('data-appearance', a)
  try {
    if (a === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, a)
  } catch {
    /* приватный режим — тема просто не запомнится */
  }
}

export function effectiveDark(a: Appearance): boolean {
  return a === 'dark' || (a === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
}
