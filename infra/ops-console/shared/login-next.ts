/**
 * Куда вернуть после входа (`/login?next=…`). Только перечисленные страницы — иначе это открытый редирект.
 * `/queue` рисует сервер, а не SPA: переход на неё — полной загрузкой страницы, не роутером.
 */
export const LOGIN_NEXT_PATHS: readonly string[] = ['/queue']

export const safeLoginNext = (value: unknown): string | null =>
  typeof value === 'string' && LOGIN_NEXT_PATHS.includes(value) ? value : null
