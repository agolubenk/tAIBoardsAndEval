/**
 * Точка входа Vercel Function (Build Output API v3, scripts/build-vercel.mjs).
 * Vercel вызывает обработчик Node `(req, res)`; Hono работает на Web Request/Response —
 * мост даёт @hono/node-server. Миграции здесь не запускаются: это шаг сборки.
 */
import { getRequestListener } from '@hono/node-server'
import { createApp } from './app'

export default getRequestListener(createApp().fetch)
