import type { Context } from 'hono'
import { z } from 'zod'
import { apiError } from '../http-types'

/** Тело запроса через Zod: неизвестные поля срезаются, ошибка — 400 с первым понятным сообщением. */
export async function parseBody<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw apiError(400, 'Тело запроса — не JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw apiError(400, issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Некорректный запрос')
  }
  return parsed.data
}

export function parseQuery<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  const parsed = schema.safeParse(c.req.query())
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw apiError(400, issue ? `${issue.path.join('.')}: ${issue.message}` : 'Некорректные параметры')
  }
  return parsed.data
}

export function parseId(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw apiError(400, 'Некорректный id')
  return n
}
