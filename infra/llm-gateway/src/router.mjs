// Имя модели от клиента → упорядоченный список кандидатов { provider: 'openrouter'|'glm'|'local', model }.
// Пулы: `auto`, `free`, `glm` (ротация GLM Z.AI), `cascade` (OR → GLM → local), GW_ALIAS_<NAME>;
// локальные: `local` (по возможностям запроса), `local/auto`, `local/<tier>`, `local/<имя>`; прочее — id OpenRouter.
import { isFreeModel } from './keypool.mjs'

const LOCAL_PREFIX = 'local/'
export const LOCAL_TIERS = ['code', 'reason', 'long', 'fast']

// Грубая оценка токенов запроса по байтам. Нижняя — фильтр облачных моделей по контексту (ошибка
// «слишком длинно» всё равно уйдёт в ротацию); верхняя — для локальной модели, где Ollama обрезает молча.
export function estimateTokens(bytes) {
  return { low: Math.ceil(bytes / 4), high: Math.ceil(bytes / 2.5) }
}

// Что нужно запросу от модели — по самому телу, без догадок.
export function requestNeeds(body, bytes) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  const parts = (m) => (Array.isArray(m?.content) ? m.content : [])
  const vision = msgs.some((m) => parts(m).some((p) => p?.type === 'image_url' || p?.type === 'input_image'))
  const audio = msgs.some((m) => parts(m).some((p) => p?.type === 'input_audio' || p?.type === 'audio_url' || p?.type === 'audio'))
  return { tools: Array.isArray(body?.tools) && body.tools.length > 0, vision, audio, tokens: estimateTokens(bytes) }
}

// Контекст локальной модели в работе: загруженная — фактический из /api/ps (он бывает меньше тега: glm46v:24k
// держит 13 900), иначе num_ctx из Modelfile, иначе подсказка в теге (`:24k`), иначе обученное окно, но не больше
// GW_LOCAL_MAX_CONTEXT: без num_ctx Ollama грузит с OLLAMA_CONTEXT_LENGTH сервера, которого шлюз не знает, а длинный
// промпт на ноутбуке — минуты префилла и гигабайты KV-кэша.
export function localContext(discovery, name) {
  const loaded = discovery.local?.loadedCtx?.[name]
  if (loaded) return loaded
  const m = discovery.local?.models?.find((x) => x.name === name)
  if (m?.numCtx) return m.numCtx
  const hint = /[:-](\d+)k\b/i.exec(name)
  if (hint) return Number(hint[1]) * 1024
  return Math.min(m?.context || 4096, discovery.cfg?.localMaxContext || 32_768)
}

export class Router {
  constructor(cfg, pool, discovery) {
    this.cfg = cfg
    this.pool = pool
    this.discovery = discovery
    this.offsets = new Map()
  }

  poolNames() {
    const names = ['auto', 'free']
    if (this.pool.modelsOf('glm').length) names.push('glm')
    names.push('cascade')
    return [...names, ...Object.keys(this.cfg.aliases)]
  }

  glmModels() {
    return this.pool.modelsOf('glm')
  }

  // Можно ли слать модель в OpenRouter: при GW_OPENROUTER_FREE_ONLY (по умолчанию) — только бесплатная
  // (`:free` или нулевая цена в каталоге). Платная не уходит ни из пула, ни прямым выбором клиента.
  orAllowed(id) {
    return !this.cfg.openrouterFreeOnly || isFreeModel(id) || this.discovery.catalog.get(id)?.free === true
  }

  // Модель, которую шлюз реально отправит: GLM и локальные — да, OpenRouter — с учётом free-only.
  servable(id) {
    return id.startsWith(LOCAL_PREFIX) || this.pool.upstreamFor(id) !== 'openrouter' || this.orAllowed(id)
  }

  // Запасные из пула `free` (помечены backup: прокси пробует их, только если выбранная недоступна надолго).
  freeBackups(need, exclude = null) {
    return this.rotate('free', this.fit(this.poolModels('free', need), need))
      .filter((m) => m !== exclude)
      .map((model) => ({ provider: 'openrouter', model, backup: true }))
  }

  // Прямо выбранная модель OpenRouter → она сама, затем запасные из пула `free`: снятая с OpenRouter или
  // упёршаяся в лимит модель не роняет запрос, клиент видит подмену в заголовке x-gateway-model.
  // Платная при free-only — её `:free`-вариант, если он есть, иначе сразу пул `free`.
  directOpenrouter(id, need) {
    let first = this.orAllowed(id) ? id : null
    if (!first && this.pool.upstreamFor(`${id}:free`) === 'openrouter' && this.discovery.catalog.has(`${id}:free`)) first = `${id}:free`
    return [...(first ? [{ provider: 'openrouter', model: first }] : []), ...this.freeBackups(need, first)]
  }

  // Без фильтра по возможностям: модели пула как они есть (для /v1/models и синхронизации клиентов).
  poolModels(name, need = {}) {
    if (name === 'auto') {
      const configured = this.pool.configuredModels()
      if (configured.length) return configured
      return this.pool.size ? this.discovery.topFree(this.cfg.autoFreeCount, { tools: !!need.tools }) : []
    }
    if (name === 'free') {
      const configured = this.pool.configuredModels().filter(isFreeModel)
      const top = this.discovery.topFree(this.cfg.autoFreeCount, { tools: !!need.tools })
      // Только то, что разрешено хоть одному ключу OpenRouter: модель вне OPENROUTER_MODELS_<n> всё равно не уйдёт.
      return [...new Set([...configured, ...top])].filter((id) => this.pool.upstreamFor(id) === 'openrouter')
    }
    if (name === 'glm') return this.glmModels()
    if (name === 'cascade') {
      // Только для отображения в /v1/models и клиентах; сам ресолв — в resolve() (группы кандидатов).
      return [...this.poolModels('auto', need), ...this.glmModels(), ...this.localFitModels(need)]
    }
    return this.cfg.aliases[name] || null
  }

  // Убирает модели, которые заведомо не потянут запрос (по каталогу). Пусто после фильтра — вернуть как было:
  // каталог мог устареть, пусть решает апстрим.
  fit(models, need) {
    const ok = models.filter((id) => {
      if (id.startsWith(LOCAL_PREFIX)) return true
      const m = this.discovery.catalog.get(id)
      if (!m) return true
      if (need.tools && !m.tools) return false
      if (need.vision && !m.vision) return false
      if (m.context && need.tokens && need.tokens.low > m.context) return false
      return true
    })
    return ok.length ? ok : models
  }

  rotate(name, list) {
    if (this.cfg.strategy !== 'roundrobin' || list.length < 2) return list
    const i = (this.offsets.get(name) || 0) % list.length
    this.offsets.set(name, i + 1)
    return [...list.slice(i), ...list.slice(0, i)]
  }

  // Чатовыe локальные модели, которые тянут запрос: tools/vision/audio по caps, контекст — с запасом 10%
  // (Ollama молча обрезает начало диалога, если окно меньше запроса).
  localFitModels(need = {}) {
    return this.discovery.local.models
      .filter((m) => m.chat)
      .filter((m) => (!need.tools || m.tools) && (!need.vision || m.vision) && (!need.audio || m.audio))
      .filter((m) => !need.tokens || need.tokens.high <= localContext(this.discovery, m.name) * 0.9)
      .map((m) => `${LOCAL_PREFIX}${m.name}`)
  }

  // Тир локальной ротации: явный список из .env (GW_LOCAL_CODE и т.д.) или авто-определение.
  // Авто: code — по имени (coder/tiel/…), reason — reasoning-имена, long — окно ≥ 64k, fast — до ~7 ГБ.
  localTierModels(tier, need) {
    const chat = this.discovery.local.models.filter((m) => m.chat)
    const have = new Set(chat.map((m) => m.name))
    const explicit = (this.cfg.localTiers[tier] || []).filter((n) => have.has(n)).map((n) => `${LOCAL_PREFIX}${n}`)
    if (explicit.length) return this.fitLocalList(explicit, need)
    const byName = (re) => chat.filter((m) => re.test(m.name)).map((m) => `${LOCAL_PREFIX}${m.name}`)
    let auto
    if (tier === 'code') auto = byName(/coder|codestral|codellama|codegpt|tiel/i)
    else if (tier === 'reason') auto = byName(/deepseek-r|reason|think|\br1\b/i)
    else if (tier === 'long') auto = chat.filter((m) => localContext(this.discovery, m.name) >= 65536).map((m) => `${LOCAL_PREFIX}${m.name}`)
    else auto = chat.filter((m) => m.sizeBytes && m.sizeBytes < 7e9).map((m) => `${LOCAL_PREFIX}${m.name}`)
    return this.fitLocalList(auto, need)
  }

  // Тир не тянет запрос (нет vision-модели и т.п.) — вместо пустоты общий локальный набор.
  fitLocalList(models, need) {
    const fit = models.filter((id) => this.localFitModels(need).includes(id))
    return fit.length ? fit : this.localFitModels(need)
  }

  localCandidates(models, need) {
    return models.map((id) => this.localCandidate(id.slice(LOCAL_PREFIX.length), need)).filter(Boolean)
  }

  localCandidate(name, need) {
    if (name === 'auto' || !name) {
      const fits = (n) => !need.tokens || need.tokens.high <= localContext(this.discovery, n) * 0.9
      const model = this.discovery.pickLocal({ tools: need.tools, vision: need.vision, fits })
      return model ? this.localCand(model) : null
    }
    const known = this.discovery.local.models.some((m) => m.chat && m.name === name)
    return known ? this.localCand(name) : null
  }

  // «Нет thinking» фиксируется при выборе, а не при попытке: до локального хвоста каскада неудачный
  // refreshLocal успеет обнулить список моделей, и поля рассуждений ушли бы в Ollama (400).
  localCand(name) {
    const m = this.discovery.local.models.find((x) => x.name === name)
    return { provider: 'local', model: name, ...(m?.thinking === false ? { thinking: false } : {}) }
  }

  openrouterCandidates(models, need) {
    if (!this.pool.size) return []
    return this.fit(models, need)
      .map((id) => ({ provider: 'openrouter', model: id }))
      .filter((c) => this.pool.upstreamFor(c.model) !== 'glm' && this.orAllowed(c.model))
  }

  glmCandidates(models) {
    return models.filter((m) => this.pool.upstreamFor(m) === 'glm').map((m) => ({ provider: 'glm', model: m }))
  }

  resolve(requested, need = {}) {
    const name = String(requested || 'auto').trim()
    if (name.startsWith(LOCAL_PREFIX)) {
      const rest = name.slice(LOCAL_PREFIX.length)
      let candidates
      if (LOCAL_TIERS.includes(rest)) {
        candidates = this.cfg.localEnabled ? this.localCandidates(this.rotate(`local-${rest}`, this.localTierModels(rest, need)), need) : []
      } else {
        const c = this.cfg.localEnabled && this.localCandidate(rest, need)
        candidates = c ? [c] : []
      }
      return { name, pool: false, candidates }
    }
    if (name === 'glm') {
      const models = this.rotate('glm', this.fit(this.glmModels(), need))
      return { name, pool: true, candidates: this.glmCandidates(models) }
    }
    if (name === 'cascade') {
      // Порядок групп = стратегия: OpenRouter → GLM → локальная. Провайдер с GW_PROVIDER_SKIP_AFTER
      // подряд отказов пропускается целиком (см. proxy).
      return {
        name,
        pool: true,
        candidates: [
          ...this.openrouterCandidates(this.rotate('cascade-or', this.poolModels('auto', need)), need),
          ...this.glmCandidates(this.rotate('cascade-glm', this.glmModels())),
          ...this.localCandidates(this.rotate('cascade-local', this.localFitModels(need)), need),
        ],
      }
    }
    if (name === 'local') {
      return { name, pool: true, candidates: this.cfg.localEnabled ? this.localCandidates(this.rotate('local', this.localFitModels(need)), need) : [] }
    }
    const models = this.poolModels(name, need)
    const isPool = models !== null
    let candidates
    if (!isPool && this.pool.upstreamFor(name) === 'glm') candidates = [{ provider: 'glm', model: name }]
    else if (!isPool) candidates = this.pool.size ? this.directOpenrouter(name, need) : []
    else {
      candidates = this.rotate(name, this.fit(models, need))
        .map((id) => {
          if (id.startsWith(LOCAL_PREFIX)) return this.localCandidate(id.slice(LOCAL_PREFIX.length), need)
          const upstream = this.pool.upstreamFor(id)
          if (upstream === 'glm') return { provider: 'glm', model: id }
          if (upstream === 'openrouter' && this.orAllowed(id)) return { provider: 'openrouter', model: id }
          return null
        })
        .filter(Boolean)
      // Пул/алиас из одних платных при free-only остался бы без облака — тогда запасные из `free`.
      if (this.pool.size && !candidates.some((c) => c.provider !== 'local') && models.some((id) => this.pool.upstreamFor(id) === 'openrouter')) {
        candidates.push(...this.freeBackups(need))
      }
    }
    const out = candidates
    if (this.cfg.fallbackLocal && this.cfg.localEnabled && !out.some((c) => c.provider === 'local')) {
      const local = this.localCandidate('auto', need)
      // Запрос длиннее окна локальной модели в фолбэк не идёт: Ollama молча обрезала бы начало диалога.
      if (local && (!need.tokens || need.tokens.high <= localContext(this.discovery, local.model) * 0.9)) {
        out.push({ ...local, fallback: true })
      }
    }
    return { name, pool: isPool, candidates: out }
  }
}
