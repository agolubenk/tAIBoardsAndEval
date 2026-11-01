// Автоопределение моделей: каталог OpenRouter (кэш 1 ч в памяти и на диске), состояние ключей,
// локальные модели Ollama (установленные и загруженные в память сейчас).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR } from './config.mjs'

const CATALOG_TTL_MS = 60 * 60_000
const LOCAL_TTL_MS = 15_000
const KEYINFO_TTL_MS = 10 * 60_000

async function getJson(url, { headers = {}, timeoutMs = 8_000, fetchImpl = fetch, body } = {}) {
  const init = body === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

export function normalizeCatalog(raw) {
  const out = new Map()
  for (const m of raw?.data || []) {
    const p = m.pricing || {}
    const params = m.supported_parameters || []
    out.set(m.id, {
      id: m.id,
      name: m.name || m.id,
      context: m.context_length || m.top_provider?.context_length || 0,
      maxOutput: m.top_provider?.max_completion_tokens || 0,
      tools: params.includes('tools'),
      reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
      vision: (m.architecture?.input_modalities || []).includes('image'),
      // Чатовая = текст на входе и только текст на выходе; генераторы музыки/картинок (text+audio и т.п.) в пулы не берём.
      text: (m.architecture?.input_modalities || ['text']).includes('text') && (m.architecture?.output_modalities || ['text']).every((x) => x === 'text'),
      free: Number(p.prompt) === 0 && Number(p.completion) === 0 && Number(p.request || 0) === 0,
      promptPrice: Number(p.prompt) || 0,
      completionPrice: Number(p.completion) || 0,
    })
  }
  return out
}

export class Discovery {
  constructor(cfg, { fetchImpl = fetch, now = Date.now, persist = true } = {}) {
    this.cfg = cfg
    this.fetchImpl = fetchImpl
    this.now = now
    this.persist = persist
    this.catalog = new Map()
    this.catalogAt = 0
    this.local = { models: [], loaded: [], at: 0, error: null }
    this.shown = new Map() // `${name}@${digest}` → параметры модели из /api/show (меняются только с самой моделью)
    this.keyInfo = new Map()
    this.keyInfoAt = 0
    if (persist) this.loadCachedCatalog()
  }

  loadCachedCatalog() {
    const file = join(STATE_DIR, 'catalog.json')
    if (!existsSync(file)) return
    try {
      const { at, raw } = JSON.parse(readFileSync(file, 'utf8'))
      this.catalog = normalizeCatalog(raw)
      this.catalogAt = at
    } catch {
      /* битый кэш — просто перезапросим */
    }
  }

  async refreshCatalog({ force = false } = {}) {
    if (!force && this.catalog.size && this.now() - this.catalogAt < CATALOG_TTL_MS) return this.catalog
    try {
      const raw = await getJson(`${this.cfg.openrouterUrl}/models`, { fetchImpl: this.fetchImpl, timeoutMs: 15_000 })
      this.catalog = normalizeCatalog(raw)
      this.catalogAt = this.now()
      if (this.persist) {
        mkdirSync(STATE_DIR, { recursive: true })
        writeFileSync(join(STATE_DIR, 'catalog.json'), JSON.stringify({ at: this.catalogAt, raw }))
      }
    } catch (err) {
      this.catalogError = err.message
    }
    return this.catalog
  }

  // Бесплатные модели с поддержкой tools, от большего контекста к меньшему — пул `auto`, если ключам не заданы модели.
  topFree(n, { tools = true } = {}) {
    return [...this.catalog.values()]
      .filter((m) => m.free && m.text && (!tools || m.tools) && m.id !== 'openrouter/free')
      .sort((a, b) => b.context - a.context || a.id.localeCompare(b.id))
      .slice(0, n)
      .map((m) => m.id)
  }

  async refreshLocal({ force = false } = {}) {
    if (!this.cfg.localEnabled) return this.local
    if (!force && this.now() - this.local.at < LOCAL_TTL_MS) return this.local
    try {
      const [tags, ps] = await Promise.all([
        getJson(`${this.cfg.ollamaUrl}/api/tags`, { fetchImpl: this.fetchImpl, timeoutMs: 3_000 }),
        getJson(`${this.cfg.ollamaUrl}/api/ps`, { fetchImpl: this.fetchImpl, timeoutMs: 3_000 }).catch(() => ({ models: [] })),
      ])
      const excluded = (name) => this.cfg.localExclude.some((s) => name.toLowerCase().includes(s.toLowerCase()))
      await this.showParams(tags.models || [])
      const models = (tags.models || [])
        .map((m) => {
          const caps = m.capabilities || []
          const { numCtx = 0, numPredict = 0 } = this.shown.get(`${m.name}@${m.digest}`) || {}
          // FIM-модель автокомплита (num_predict в десятки токенов) чат не ведёт: в пулы её не берём.
          const fim = /(^|[^a-z])fim([^a-z]|$)/i.test(m.name) || (numPredict > 0 && numPredict <= 256)
          return {
            name: m.name,
            chat: !fim && (caps.length ? caps.includes('completion') && !caps.includes('embedding') : !excluded(m.name)),
            embedding: caps.includes('embedding') || /embed|nomic/i.test(m.name),
            tools: caps.includes('tools'),
            vision: caps.includes('vision'),
            audio: caps.includes('audio'),
            // null — Ollama возможностей не сообщила: рассуждения отдаём как прислал клиент.
            thinking: caps.length ? caps.includes('thinking') : null,
            context: m.details?.context_length || 0,
            numCtx,
            sizeBytes: m.size || 0,
          }
        })
        .filter((m) => !excluded(m.name) || m.embedding)
      const loadedCtx = Object.fromEntries((ps.models || []).map((m) => [m.name, m.context_length || 0]))
      this.local = { models, loaded: Object.keys(loadedCtx), loadedCtx, at: this.now(), error: null }
    } catch (err) {
      this.local = { models: [], loaded: [], loadedCtx: {}, at: this.now(), error: err.message }
    }
    return this.local
  }

  // num_ctx/num_predict из Modelfile: с этим окном Ollama модель и загрузит (обученное окно бывает в 16 раз больше).
  // Только метаданные, без загрузки модели; по одной и один раз на версию модели.
  async showParams(tagModels) {
    for (const m of tagModels) {
      const id = `${m.name}@${m.digest}`
      if (this.shown.has(id)) continue
      try {
        const { parameters = '' } = await getJson(`${this.cfg.ollamaUrl}/api/show`, { fetchImpl: this.fetchImpl, timeoutMs: 3_000, body: { model: m.name } })
        const num = (k) => Number(new RegExp(`^${k}\\s+(\\d+)`, 'm').exec(parameters)?.[1] || 0)
        this.shown.set(id, { numCtx: num('num_ctx'), numPredict: num('num_predict') })
      } catch {
        this.shown.set(id, {})
      }
    }
  }

  // Локальная модель для `local/auto`: уже загруженная в память (без холодного старта) → GW_LOCAL_DEFAULT → первая чатовая.
  // fits — влезает ли запрос в окно модели: длинный запрос не отдаём загруженной маленькой (Ollama обрезала бы начало).
  pickLocal({ tools = false, vision = false, audio = false, fits = () => true } = {}) {
    const able = this.local.models.filter((m) => m.chat && (!tools || m.tools) && (!vision || m.vision) && (!audio || m.audio))
    const chat = able.filter((m) => fits(m.name))
    if (able.length && !chat.length) return null
    const loaded = chat.find((m) => this.local.loaded.includes(m.name))
    if (loaded) return loaded.name
    const def = chat.find((m) => m.name === this.cfg.localDefault)
    return def?.name || chat[0]?.name || this.cfg.localDefault || null
  }

  async refreshKeyInfo(keys, { force = false } = {}) {
    if (!force && this.now() - this.keyInfoAt < KEYINFO_TTL_MS) return this.keyInfo
    this.keyInfoAt = this.now()
    // По одному: три коротких GET, параллелить незачем. Только ключи OpenRouter: ключ Z.AI на openrouter.ai/key
    // не отправляем — чужому провайдеру он не нужен, а ответ всё равно 401.
    for (const k of keys.filter((x) => x.upstream?.kind === 'openrouter')) {
      try {
        const { data } = await getJson(`${this.cfg.openrouterUrl}/key`, {
          fetchImpl: this.fetchImpl,
          headers: { Authorization: `Bearer ${k.key}` },
        })
        this.keyInfo.set(k.id, {
          label: data?.label,
          limit: data?.limit ?? null,
          limitRemaining: data?.limit_remaining ?? null,
          usage: data?.usage ?? null,
          isFreeTier: data?.is_free_tier ?? null,
          at: this.now(),
        })
      } catch (err) {
        this.keyInfo.set(k.id, { error: err.message, at: this.now() })
      }
    }
    return this.keyInfo
  }
}
