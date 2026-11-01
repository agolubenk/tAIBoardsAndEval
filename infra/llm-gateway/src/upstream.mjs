// Вызов апстрима (OpenRouter или Ollama /v1) и разбор его ответа/ошибки. Тело запроса уходит как пришло,
// меняются только `model`, завышенный потолок ответа (max_tokens / max_completion_tokens) и поля рассуждений
// для локальной модели без thinking.

export class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit)
    this.active = 0
    this.queue = []
  }

  get waiting() {
    return this.queue.length
  }

  // Освободившийся слот за maxWaitMs — release(), иначе null (клиенту честный 429/503, а не вечное ожидание).
  acquire(maxWaitMs, signal) {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve(() => this.release())
    }
    return new Promise((resolve) => {
      const entry = { resolve, timer: null }
      const drop = () => {
        const i = this.queue.indexOf(entry)
        if (i >= 0) this.queue.splice(i, 1)
        clearTimeout(entry.timer)
        resolve(null)
      }
      entry.timer = setTimeout(drop, maxWaitMs)
      signal?.addEventListener('abort', drop, { once: true })
      this.queue.push(entry)
    })
  }

  release() {
    const next = this.queue.shift()
    if (next) {
      clearTimeout(next.timer)
      next.resolve(() => this.release())
    } else {
      this.active--
    }
  }
}

// Потолок ответа: клиент вправе просить меньше, но не больше cap. OpenRouter резервирует кредиты под весь
// запрошенный объём — «max_tokens: 131072» на ключе с остатком в несколько тысяч токенов даёт 402.
export function clampOutput(body, cap) {
  if (!(cap > 0) || cap === Infinity) return body
  const out = { ...body }
  let clamped = false
  for (const f of ['max_tokens', 'max_completion_tokens']) {
    const n = Number(out[f])
    if (out[f] != null && Number.isFinite(n) && n > cap) (out[f] = cap), (clamped = true)
  }
  // Бюджет рассуждений обязан быть меньше max_tokens, иначе апстрим отвечает 400.
  const r = out.reasoning
  if (clamped && r && typeof r === 'object' && Number(r.max_tokens) >= cap) out.reasoning = { ...r, max_tokens: Math.floor(cap * 0.75) }
  return out
}

// Поля маршрутизации OpenRouter обходят ротацию шлюза: `models[]` — свой список запасных (в том числе платных),
// `plugins` (веб-поиск) тарифицируется отдельно. Модель выбирает шлюз; плагины — только OpenRouter и без free-only.
export function upstreamBody(cfg, cand, body) {
  const { models: _models, plugins, ...rest } = body
  return plugins !== undefined && cand.provider === 'openrouter' && !cfg.openrouterFreeOnly ? { ...rest, plugins } : rest
}

// Ollama на reasoning_effort ≠ none у модели без thinking отвечает 400 «does not support thinking», а
// openrouter-copilot шлёт его в каждом запросе. Такой модели поля рассуждений не передаём; про модель без
// известных возможностей (thinking: null) не гадаем — тело как есть.
const REASONING_FIELDS = ['reasoning_effort', 'reasoning', 'include_reasoning']
export function localBody(body, model) {
  if (model?.thinking !== false || !REASONING_FIELDS.some((f) => f in body)) return body
  const out = { ...body }
  for (const f of REASONING_FIELDS) delete out[f]
  return out
}

export function buildRequest(cfg, cand, key, path, body, accept, outputCap = Infinity) {
  const payload = JSON.stringify({ ...clampOutput(upstreamBody(cfg, cand, body), outputCap), model: cand.model })
  if (cand.provider === 'local') {
    return {
      url: `${cfg.ollamaUrl}/v1${path}`,
      init: { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: accept }, body: payload },
    }
  }
  if (cand.provider === 'glm') {
    // Z.AI: свой URL у каждого контура (Coding/General), ключ — из ключевого пула шлюза.
    return {
      url: `${key.upstream.url}${path}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: accept, Authorization: `Bearer ${key.key}` },
        body: payload,
      },
    }
  }
  return {
    url: `${cfg.openrouterUrl}${path}`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: accept,
        Authorization: `Bearer ${key.key}`,
        'HTTP-Referer': cfg.referer,
        'X-Title': cfg.title,
      },
      body: payload,
    },
  }
}

function parseRetryAfter(h, now) {
  if (!h) return undefined
  const s = Number(h)
  if (Number.isFinite(s)) return s * 1000
  const d = Date.parse(h)
  return Number.isFinite(d) ? Math.max(0, d - now) : undefined
}

// Ошибка апстрима в одном виде для пула ключей: статус, сообщение, когда можно снова.
export function describeError(status, headers, text, now = Date.now()) {
  let message = text || ''
  let code = status
  try {
    const j = JSON.parse(text)
    const e = j?.error ?? j
    if (e && typeof e === 'object') {
      const raw = e.metadata?.raw
      message = [e.message, typeof raw === 'string' ? raw : raw && JSON.stringify(raw), e.metadata?.provider_name]
        .filter(Boolean)
        .join(' | ')
      if (typeof e.code === 'number' && e.code >= 400) code = e.code
    } else if (typeof e === 'string') {
      message = e
    }
  } catch {
    /* не JSON — оставляем текст */
  }
  const reset = Number(headers?.get?.('x-ratelimit-reset'))
  return {
    status: code,
    message: String(message).slice(0, 500),
    retryAfterMs: parseRetryAfter(headers?.get?.('retry-after'), now),
    resetAt: Number.isFinite(reset) && reset > 1e12 ? reset : Number.isFinite(reset) && reset > 1e9 ? reset * 1000 : undefined,
  }
}

// Ответ 200 бывает ошибкой: OpenRouter кладёт `{"error":…}` в тело (без choices) — это тоже повод ротировать.
export function embeddedError(obj) {
  if (!obj || typeof obj !== 'object' || !obj.error) return null
  if (Array.isArray(obj.choices) && obj.choices.length && obj.choices.some((c) => c?.finish_reason !== 'error')) return null
  const e = obj.error
  return { code: typeof e.code === 'number' ? e.code : 502, text: JSON.stringify({ error: e }) }
}

// Читает SSE до первого события `data:`, ничего не теряя: сырые байты копятся и уйдут клиенту как есть.
// Таймаут — снаружи, через abort запроса: гонка read() с таймером оставила бы висящий read и съела бы чанк.
export async function readUntilFirstData(reader) {
  const decoder = new TextDecoder()
  const chunks = []
  let text = ''
  for (;;) {
    const step = await reader.read()
    if (step.done) return { chunks, firstData: null, done: true, text }
    chunks.push(step.value)
    text += decoder.decode(step.value, { stream: true })
    const lines = text.split('\n')
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].replace(/\r$/, '')
      if (line.startsWith('data:')) return { chunks, firstData: line.slice(5).trim() }
    }
  }
}

export function firstDataError(firstData) {
  if (!firstData || firstData === '[DONE]') return null
  try {
    return embeddedError(JSON.parse(firstData))
  } catch {
    return null
  }
}
