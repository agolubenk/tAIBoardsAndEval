/** Схемы каналов: что открыто (config_json) и что секретно (secret_enc) — по типу. */
import { z } from 'zod'
import type { ChannelKind } from '../db/schema'

export const channelConfigSchemas = {
  telegram: z.object({ chatId: z.string().trim().min(1, 'chat id обязателен').max(64) }),
  email: z.object({
    host: z.string().trim().min(1, 'SMTP-хост обязателен').max(190),
    port: z.coerce.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    user: z.string().trim().max(190).default(''),
    from: z.string().trim().max(190).default(''),
    to: z.string().trim().min(3, 'укажите получателей').max(1000),
  }),
  webhook: z.object({ url: z.string().trim().url('некорректный URL').max(1024) }),
} satisfies Record<ChannelKind, z.ZodTypeAny>

/** Поля секрета по типу; пустое значение при обновлении = «оставить прежний». */
export const channelSecretFields: Record<ChannelKind, string[]> = {
  telegram: ['botToken'],
  email: ['password'],
  webhook: ['signingSecret'],
}

export const channelSecretSchema = z.record(z.string().max(64), z.string().max(512))
