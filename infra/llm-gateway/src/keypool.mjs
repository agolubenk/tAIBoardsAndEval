// Пул ключей OpenRouter: темп (token bucket на RPM + минимальный интервал), кулдауны ключа и пары ключ+модель.
// Лимиты OpenRouter считаются на аккаунт: три ключа одного аккаунта ёмкости не складывают — только разносят отказы.

// «Reasoning is mandatory … cannot be disabled» — модель только с рассуждениями на reasoning_effort: none
// (openrouter-copilot так шлёт служебные запросы): другая модель пула запрос примет.
export const MODEL_SPECIFIC_400 =
  /no endpoints found|does not support|not support|is not a valid model|invalid model|context length|context_length|maximum context|too many tokens|no allowed providers|data policy|reasoning is mandatory|cannot be disabled/i

export const isFreeModel =(model) => model.endsWith(':free') || model === 'openrouter/free'

// Шаблон модели в OPENROUTER_MODELS_<n>: точный id или глоб со звёздочкой (`*:free`, `deepseek/*`).
export function modelMatches(pattern, model) {
  if (!pattern.includes('*')) return pattern === model
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return re.test(model)
}

export class KeyPool {
  constructor(keys, { minIntervalMs = 1000, now = Date.now } = {}) {
    this.now = now
    this.minIntervalMs = minIntervalMs
    this.keys = keys.map((k) => ({
      ...k,
      tokens: k.rpm || Infinity,
      refilledAt: now(),
      lastUsedAt: 0,
      until: 0, // весь ключ недоступен (401/403, сетевой сбой)
      paidUntil: 0, // 402: кончились кредиты — платные модели нельзя
      freeUntil: 0, // дневной лимит бесплатных моделей исчерпан
      modelUntil: new Map(), // `${model}` → время, до которого пара ключ+модель на паузе
      strikes: new Map(), // подряд идущие 429 по паре — для экспоненциальной паузы
      lastError: null,
      ok: 0,
      failed: 0,
    }))
    this.rr = 0
  }

  get size() {
    return this.keys.length
  }

  // Провайдер модели: каким ключом она обслуживается. GLM-модель всегда идёт на GLM-ключ
  // (у OpenRouter другие id), прочее — OpenRouter. null — ключей под модель нет.
  upstreamFor(model) {
    for (const k of this.keys) if (k.upstream?.kind === 'glm' && this.allows(k, model)) return 'glm'
    for (const k of this.keys) if (k.upstream?.kind === 'openrouter' && this.allows(k, model)) return 'openrouter'
    return null
  }

  // Модели конкретного провайдера в конфиге (для пулов и синхронизации клиентов).
  modelsOf(kind) {
    const out = []
    for (const k of this.keys) if (k.upstream?.kind === kind) for (const m of k.models) if (!out.includes(m)) out.push(m)
    return out
  }

  allows(k, model) {
    return !k.models.length || k.models.some((p) => modelMatches(p, model))
  }

  // Модели, явно перечисленные в OPENROUTER_MODELS_<n> (без глобов) — в порядке ключей, без повторов.
  // Ключи GLM сюда не входят: их модели живут в пуле `glm`, а не в OpenRouter-ротации.
  configuredModels() {
    const out = []
    for (const k of this.keys) {
      if (k.upstream?.kind !== 'openrouter') continue
      for (const m of k.models) if (!m.includes('*') && !out.includes(m)) out.push(m)
    }
    return out
  }

  refill(k, t) {
    if (!k.rpm) return
    const add = ((t - k.refilledAt) * k.rpm) / 60_000
    k.tokens = Math.min(k.rpm, k.tokens + add)
    k.refilledAt = t
  }

  // Когда ключ сможет взять запрос к модели: 0 — сейчас, Infinity — никогда (модель ему не разрешена).
  readyAt(k, model, t = this.now()) {
    if (!this.allows(k, model)) return Infinity
    this.refill(k, t)
    let at = Math.max(k.until, k.modelUntil.get(model) || 0, k.lastUsedAt + this.minIntervalMs)
    if (isFreeModel(model)) at = Math.max(at, k.freeUntil)
    else at = Math.max(at, k.paidUntil)
    if (k.tokens < 1) at = Math.max(at, t + ((1 - k.tokens) * 60_000) / k.rpm)
    return at <= t ? 0 : at
  }

  // Ближайший момент, когда модель возьмёт хоть один ключ провайдера (сейчас — t), без захвата слота: для Retry-After.
  nextReady(model, kind = null) {
    const t = this.now()
    let best = Infinity
    for (const k of this.keys) {
      if (kind && k.upstream?.kind !== kind) continue
      best = Math.min(best, this.readyAt(k, model, t) || t)
    }
    return best
  }

  // Берёт ключ для модели. Готовых несколько — по кругу, чтобы нагрузка расходилась по ключам.
  // Иначе возвращает { key: null, waitUntil } — ближайший момент, когда ключ освободится (или Infinity).
  // kind — провайдер кандидата: ключ OpenRouter с пустым списком моделей «разрешает всё», и без фильтра
  // запрос к glm-4.6 уходил бы на openrouter.ai.
  acquire(model, kind = null) {
    const t = this.now()
    let best = Infinity
    const ready = []
    for (const k of this.keys) {
      if (kind && k.upstream?.kind !== kind) continue
      const at = this.readyAt(k, model, t)
      if (at === 0) ready.push(k)
      else best = Math.min(best, at)
    }
    if (!ready.length) return { key: null, waitUntil: best }
    const k = ready[this.rr++ % ready.length]
    if (k.rpm) k.tokens -= 1
    k.lastUsedAt = t
    return { key: k, waitUntil: 0 }
  }

  success(k, model) {
    k.ok++
    k.strikes.delete(model)
    k.lastError = null
  }

  // Классификация отказа апстрима → какая пауза на что. Возвращает 'rotate' (пробовать дальше) или 'final'.
  failure(k, model, { status, retryAfterMs, resetAt, message = '' }) {
    const t = this.now()
    k.failed++
    k.lastError = { at: t, status, model, message: message.slice(0, 200) }
    const msg = message.toLowerCase()
    if (status === 401 || status === 403) {
      // 403 «moderation»/«region» — про запрос/модель, не про ключ.
      if (status === 403 && /moderat|flagged|region|country|not available in your/.test(msg)) {
        k.modelUntil.set(model, t + 30 * 60_000)
        return 'rotate'
      }
      k.until = t + 60 * 60_000
      return 'rotate'
    }
    if (status === 402) {
      if (isFreeModel(model)) k.freeUntil = Math.max(k.freeUntil, t + 10 * 60_000)
      else k.paidUntil = t + 10 * 60_000
      return 'rotate'
    }
    if (status === 429) {
      // Z.AI: окно подписки/кошелёк исчерпаны — на паузу весь ключ, перебор моделей ничего не даст
      // (правило 04: «исчерпание окна плана — облако на паузу, не долбить повторами»).
      if (/insufficient balance|no resource package/.test(msg)) {
        k.until = t + 10 * 60_000
        return 'rotate'
      }
      if (isFreeModel(model) && /per[- ]day|daily|free-models-per-day/.test(msg)) {
        k.freeUntil = resetAt && resetAt > t ? resetAt : t + 60 * 60_000
        return 'rotate'
      }
      const n = (k.strikes.get(model) || 0) + 1
      k.strikes.set(model, n)
      const backoff = Math.min(5_000 * 2 ** (n - 1), 10 * 60_000)
      const wait = retryAfterMs ?? (resetAt && resetAt > t ? resetAt - t : backoff)
      k.modelUntil.set(model, t + Math.min(Math.max(wait, 1_000), 60 * 60_000))
      return 'rotate'
    }
    if (status === 404 || (status === 400 && MODEL_SPECIFIC_400.test(msg))) {
      // Модель снята/нет провайдера под параметры запроса — ей пауза, ключ ни при чём.
      // Прочие 400 — ошибка самого запроса: на другой модели она повторится, отдаём клиенту как есть.
      k.modelUntil.set(model, t + 30 * 60_000)
      return 'rotate'
    }
    if (status === 408 || status === 0 || status >= 500) {
      k.modelUntil.set(model, t + 15_000)
      return 'rotate'
    }
    return 'final'
  }

  snapshot() {
    const t = this.now()
    return this.keys.map((k) => ({
      id: k.id,
      rpm: k.rpm,
      tokens: Number.isFinite(k.tokens) ? Math.floor(k.tokens) : null,
      models: k.models,
      disabledForMs: Math.max(0, k.until - t),
      paidPausedForMs: Math.max(0, k.paidUntil - t),
      freePausedForMs: Math.max(0, k.freeUntil - t),
      modelPauses: [...k.modelUntil].filter(([, u]) => u > t).map(([model, u]) => ({ model, forMs: u - t })),
      ok: k.ok,
      failed: k.failed,
      lastError: k.lastError,
    }))
  }
}
