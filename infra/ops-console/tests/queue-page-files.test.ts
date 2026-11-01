/**
 * Вложения на странице /queue (page-files.ts): чистые функции — лимиты до отправки, тексты отказов, «ещё грузятся» и
 * сводка, которой страница доверяет. DOM-часть проверяется живьём в браузере (PR: сценарии загрузки, отмены, повтора).
 */
import { createContext, runInContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { FILES_JS } from '../server/queue/page-files'
import { FILES_PURE } from '../server/queue/page-files-pure'

type Limits = { maxBytes: number; maxPerItem: number; kinds: string[]; retentionDays: number }
type Plan = { rows: { name: string; reason: string | null }[]; send: { name: string }[]; failed: { name: string; reason: string }[]; expected: number; skipped: number }
type Pure = {
  oqfEsc: (s: string) => string
  oqfSize: (n: number) => string
  oqfHint: (l?: Limits) => string
  oqfPlan: (files: { name: string; size: number }[], l?: Limits, room?: number) => Plan
  oqfFallbackText: (names: string[]) => string
  oqfUploadError: (status: number, message: string) => { reason: string; retry: boolean }
  oqfUploadTimeout: (size: number) => number
  oqfPending: (meta: { expected: number; failed?: unknown[]; receivedAt: string } | null, ready: number, now: number) => 'none' | 'loading' | 'lost'
  oqfUsage: (u: unknown) => { text: string; warn: boolean } | null
  oqfCleanSummary: (j: unknown) => { enabled: boolean; limits?: Limits; items: Record<string, { files: { id: string; name: string; size: number }[]; count: number; expired: number }> }
}

// Блок из кода репозитория (не ввод) исполняется в отдельном контексте vm без доступа к тесту.
function pure(): Pure {
  const ctx = createContext({}) as unknown as Pure
  runInContext(FILES_PURE, ctx)
  return ctx
}

const LIMITS: Limits = { maxBytes: 20 * 1024 * 1024, maxPerItem: 5, kinds: ['image', 'pdf', 'doc', 'sheet', 'text'], retentionDays: 90 }
const MB = 1024 * 1024

describe('вложения на странице: до отправки', () => {
  it('подсказка — из настроек консоли, по-русски', () => {
    const { oqfHint } = pure()
    expect(oqfHint(LIMITS)).toBe('до 5 файлов, 20 МБ; картинки, PDF, docx, xlsx, текст/лог')
    expect(oqfHint({ ...LIMITS, maxPerItem: 1, maxBytes: 5 * MB, kinds: ['image'] })).toBe('до 1 файла, 5 МБ; картинки')
    expect(oqfHint({ ...LIMITS, maxPerItem: 10 })).toContain('до 10 файлов')
  })

  it('размеры: байты, килобайты целыми, мегабайты с запятой до 10', () => {
    const { oqfSize } = pure()
    expect(oqfSize(512)).toBe('512 Б')
    expect(oqfSize(12 * 1024 + 300)).toBe('12 КБ')
    expect(oqfSize(3.44 * MB)).toBe('3,4 МБ')
    expect(oqfSize(412 * MB)).toBe('412 МБ')
    expect(oqfSize(4096 * MB)).toBe('4 ГБ')
    expect(oqfSize(Number.NaN)).toBe('')
  })

  it('пустой, больше лимита и сверх числа файлов — сразу в отказ с причиной, остальное — на загрузку', () => {
    const { oqfPlan } = pure()
    const files = [
      { name: 'a.png', size: 10 },
      { name: 'empty.txt', size: 0 },
      { name: 'big.log', size: 21 * MB },
      { name: 'b.pdf', size: 10 },
      { name: 'c.pdf', size: 10 },
    ]
    const plan = oqfPlan(files, { ...LIMITS, maxPerItem: 2 })
    expect(plan.send.map((r) => r.name)).toEqual(['a.png', 'b.pdf'])
    expect(plan.failed).toEqual([
      { name: 'empty.txt', reason: 'пустой файл' },
      { name: 'big.log', reason: 'больше 20 МБ — обрежьте лог или пришлите ссылку текстом' },
      { name: 'c.pdf', reason: 'сверх лимита: не больше 2 файлов на задачу' },
    ])
    // Агент ждёт столько, сколько владелец приложил: готово + отказано = обещано.
    expect(plan.expected).toBe(5)
  })

  it('к карточке докрепляется только остаток лимита; имя без файла — «файл»', () => {
    const { oqfPlan } = pure()
    const plan = oqfPlan([{ name: 'a.txt', size: 1 }, { name: '', size: 1 }], LIMITS, 1)
    expect(plan.send.map((r) => r.name)).toEqual(['a.txt'])
    expect(plan.failed).toEqual([{ name: 'файл', reason: 'сверх лимита: не больше 5 файлов на задачу' }])
    expect(oqfPlan([{ name: 'x', size: 1 }], LIMITS, -3).failed).toHaveLength(1)
  })

  it('больше 20 файлов разом — в пункт уходят первые 20 (потолок схемы входящего)', () => {
    const { oqfPlan } = pure()
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.txt`, size: 1 }))
    expect(oqfPlan(many, LIMITS).expected).toBe(20)
    // Остальные пять не теряются молча: страница пишет «ещё 5 файлов — за один раз не больше 20» (линза GLM #313).
    expect(oqfPlan(many, LIMITS).skipped).toBe(5)
    expect(oqfPlan(many.slice(0, 3), LIMITS).skipped).toBe(0)
  })

  it('ожидание загрузки — от размера: медленный 3G (8 КБ/с) успевает, но не дольше часа', () => {
    const { oqfUploadTimeout } = pure()
    expect(oqfUploadTimeout(MB)).toBe(15 * 60_000)
    // 20 МБ при 8 КБ/с — 2560 с, плюс 2 минуты на разбор у консоли: 44 мин 40 с, а не прежние 15 минут.
    expect(oqfUploadTimeout(20 * MB)).toBe(2_680_000)
    expect(oqfUploadTimeout(200 * MB)).toBe(60 * 60_000)
    expect(oqfUploadTimeout(Number.NaN)).toBe(15 * 60_000)
  })

  it('только файлы, без текста — задача называется по первому', () => {
    const { oqfFallbackText } = pure()
    expect(oqfFallbackText(['отчёт.pdf'])).toBe('Вложение: отчёт.pdf')
    expect(oqfFallbackText(['отчёт.pdf', 'лог.txt', 'скрин.png'])).toBe('Вложение: отчёт.pdf и ещё 2')
    expect(oqfFallbackText([])).toBe('')
  })
})

describe('вложения на странице: отказы и ожидание', () => {
  it('ответ консоли → строка владельцу; повтор — только там, где тот же файл может пройти', () => {
    const { oqfUploadError } = pure()
    expect(oqfUploadError(415, 'Файл не принят: архивы не принимаются')).toEqual({ reason: 'файл не принят: архивы не принимаются', retry: false })
    expect(oqfUploadError(413, 'Файл больше 20 МБ')).toEqual({ reason: 'файл больше 20 МБ', retry: false })
    expect(oqfUploadError(409, 'У входящего уже 5 файлов — больше нельзя').retry).toBe(false)
    expect(oqfUploadError(404, '')).toEqual({ reason: 'задача удалена', retry: false })
    expect(oqfUploadError(0, '')).toEqual({ reason: 'нет связи с сервером', retry: true })
    expect(oqfUploadError(507, 'На сервере мало места — файл не принят')).toEqual({ reason: 'на сервере мало места — файл не принят', retry: true })
    expect(oqfUploadError(429, '').retry).toBe(true)
    expect(oqfUploadError(403, 'Нужна область owner').reason).toBe('сессия истекла — войдите заново и повторите')
    expect(oqfUploadError(500, '')).toEqual({ reason: 'ошибка сервера (500)', retry: true })
    expect(oqfUploadError(408, '')).toEqual({ reason: 'загрузка не успела — повторите', retry: true })
  })

  it('«ещё грузятся» — пока готово и отказано меньше обещанного и прошло меньше часа; дальше — «не дошли»', () => {
    const { oqfPending } = pure()
    const at = Date.parse('2026-10-21T20:00:00Z')
    const meta = { expected: 3, failed: [{}], receivedAt: '2026-10-21T20:00:00Z' }
    expect(oqfPending(meta, 1, at + 60_000)).toBe('loading')
    expect(oqfPending(meta, 2, at + 60_000)).toBe('none')
    expect(oqfPending(meta, 1, at + 3_600_000)).toBe('lost')
    expect(oqfPending({ ...meta, receivedAt: 'вчера' }, 0, at)).toBe('lost')
    expect(oqfPending(null, 0, at)).toBe('none')
    expect(oqfPending({ expected: 0, receivedAt: '' }, 0, at)).toBe('none')
  })

  it('строка места — тихая; предупреждение — когда консоль сказала warn; пусто — строки нет', () => {
    const { oqfUsage } = pure()
    expect(oqfUsage({ usedBytes: 412 * MB, capBytes: 4096 * MB, warn: false })).toEqual({ text: 'Вложения: 412 МБ из 4 ГБ', warn: false })
    expect(oqfUsage({ usedBytes: 3900 * MB, capBytes: 4096 * MB, warn: true })?.warn).toBe(true)
    expect(oqfUsage({ usedBytes: 0, capBytes: 4096 * MB, warn: false })).toBeNull()
    expect(oqfUsage(null)).toBeNull()
  })
})

describe('вложения на странице: сводке доверяем только по форме', () => {
  it('id файла — 32 hex (уходит в href), имя — строка; выключенное хранилище — enabled: false', () => {
    const { oqfCleanSummary } = pure()
    const good = 'a'.repeat(32)
    const s = oqfCleanSummary({
      enabled: true,
      limits: { maxBytes: 5, maxPerItem: 99, kinds: ['image', 7], retentionDays: 30.4 },
      usage: { usedBytes: '10', capBytes: 100, warn: 'yes' },
      items: {
        'i-1': { files: [{ id: good, name: 'ok.png', size: 3 }, { id: 'javascript:alert(1)', name: 'x' }, { id: good, name: 42 }], expired: 2 },
        'i-2': 'мусор',
      },
    })
    expect(s.items).toEqual({ 'i-1': { files: [{ id: good, name: 'ok.png', size: 3 }], count: 1, expired: 2 } })
    // Старый пункт: строк в сводке нет, счётчик есть — карточка покажет «Вложений: 4 — показать».
    expect(oqfCleanSummary({ enabled: true, items: { 'i-2': { files: [], count: 4 } } }).items['i-2']).toEqual({ files: [], count: 4, expired: 0 })
    expect(s.limits).toEqual({ maxBytes: 5, maxPerItem: 20, kinds: ['image'], retentionDays: 30 })
    expect(oqfCleanSummary({ enabled: false })).toEqual({ enabled: false, items: {} })
    expect(oqfCleanSummary(null).enabled).toBe(false)
  })

  it('имена — данные третьих лиц: в HTML карточки только экранированными', () => {
    const { oqfEsc } = pure()
    expect(oqfEsc('<img src=x onerror=alert(1)>.png')).toBe('&lt;img src=x onerror=alert(1)&gt;.png')
    expect(oqfEsc('x" onclick="y\'.pdf')).toBe('x&quot; onclick=&quot;y&#39;.pdf')
  })

  it('скрипт встраивается в HTML безопасно: без </script> и без незакрытой подстановки шаблона', () => {
    expect(FILES_JS).not.toMatch(/<\/script/i)
    expect(FILES_JS).not.toContain('${')
    expect(FILES_JS).not.toContain('`')
    // Скрипт целиком компилируется (без запуска): синтаксическая ошибка выключила бы и форму.
    expect(() => new Script(FILES_JS)).not.toThrow()
  })
})
