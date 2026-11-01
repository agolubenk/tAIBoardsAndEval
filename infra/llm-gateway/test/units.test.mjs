import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDotenv, loadConfig } from '../src/config.mjs'
import { KeyPool, modelMatches } from '../src/keypool.mjs'
import { Router, requestNeeds, localContext } from '../src/router.mjs'
import { buildRequest, clampOutput, describeError, embeddedError, firstDataError, localBody } from '../src/upstream.mjs'
import { clientModels, continueLocalRoles, continueYaml, mergeVscode, topLevelBlocks, upsertEnvLine, VSCODE_ENTRY_NAME } from '../src/sync-clients.mjs'
import { Discovery } from '../src/discovery.mjs'
import { Proxy, pathCandidates, servesPath } from '../src/proxy.mjs'
import { routePath } from '../src/server.mjs'

const cfgFrom = (env) => loadConfig({ envFile: '/nonexistent', env: { GW_TOKEN: 't', ...env } })

test('dotenv: кавычки, комментарии, export', () => {
  const e = parseDotenv('# c\nexport A=1\nB="x # y"\nC=z # хвост\n\nD=\n')
  assert.deepEqual(e, { A: '1', B: 'x # y', C: 'z', D: '' })
})

test('config: ключи 1..3 с моделями и RPM, пулы GW_ALIAS_*', () => {
  const cfg = cfgFrom({ OPENROUTER_KEY_1: 'k1', OPENROUTER_MODELS_1: 'a/x:free, b/y', OPENROUTER_KEY_3: 'k3', OPENROUTER_RPM_3: '5', GW_ALIAS_MY_CODER: 'a/x:free,local/q' })
  assert.deepEqual(cfg.keys.map((k) => [k.id, k.models, k.rpm]), [['or1', ['a/x:free', 'b/y'], 20], ['or3', [], 5]])
  assert.deepEqual(cfg.aliases, { 'my-coder': ['a/x:free', 'local/q'] })
  assert.throws(() => cfgFrom({ GW_HOST: '0.0.0.0' }), /loopback/)
})

test('keypool: глоб моделей и разрешения ключа', () => {
  assert.ok(modelMatches('*:free', 'a/b:free'))
  assert.ok(modelMatches('deepseek/*', 'deepseek/v3'))
  assert.ok(!modelMatches('deepseek/*', 'qwen/x'))
  const pool = new KeyPool([{ id: 'or1', key: 'k', models: ['a/*'], rpm: 0 }], { minIntervalMs: 0 })
  assert.equal(pool.acquire('b/x').waitUntil, Infinity)
  assert.equal(pool.acquire('a/x').key.id, 'or1')
})

test('keypool: RPM-ведро и минимальный интервал замедляют ключ', () => {
  let t = 1_000_000
  const pool = new KeyPool([{ id: 'or1', key: 'k', models: [], rpm: 2 }], { minIntervalMs: 500, now: () => t })
  assert.ok(pool.acquire('m').key)
  assert.equal(pool.acquire('m').waitUntil, t + 500)
  t += 500
  assert.ok(pool.acquire('m').key)
  const w = pool.acquire('m').waitUntil
  assert.ok(w > t + 500, 'ведро пусто — ждать пополнения, не только интервала')
})

test('keypool: 429 — экспоненциальная пауза пары, Retry-After главнее; суточный лимит free — на весь ключ', () => {
  let t = 0
  const pool = new KeyPool([{ id: 'or1', key: 'k', models: [], rpm: 0 }], { minIntervalMs: 0, now: () => t })
  const k = pool.keys[0]
  pool.failure(k, 'm', { status: 429 })
  assert.equal(k.modelUntil.get('m'), 5_000)
  pool.failure(k, 'm', { status: 429 })
  assert.equal(k.modelUntil.get('m'), 10_000)
  pool.failure(k, 'm', { status: 429, retryAfterMs: 2_000 })
  assert.equal(k.modelUntil.get('m'), 2_000)
  pool.failure(k, 'x:free', { status: 429, message: 'Rate limit exceeded: free-models-per-day', resetAt: 99_000 })
  assert.equal(k.freeUntil, 99_000)
  assert.equal(pool.acquire('y:free').key, null, 'другая бесплатная модель тоже на паузе')
  assert.ok(pool.acquire('paid/model').key, 'платные — можно')
})

test('keypool: обычный 400 — отдать клиенту, модельный 400 — ротация', () => {
  const pool = new KeyPool([{ id: 'or1', key: 'k', models: [], rpm: 0 }])
  const k = pool.keys[0]
  assert.equal(pool.failure(k, 'm', { status: 400, message: 'messages: field required' }), 'final')
  assert.equal(pool.failure(k, 'm', { status: 400, message: 'No endpoints found that support tool use' }), 'rotate')
  // Модель только с рассуждениями на reasoning_effort: none (служебные запросы openrouter-copilot) — другую модель пула.
  assert.equal(pool.failure(k, 'r', { status: 400, message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' }), 'rotate')
  assert.equal(pool.failure(k, 'm', { status: 401 }), 'rotate')
  assert.ok(k.until > Date.now(), '401 выключает ключ')
})

function fakeDiscovery(catalog = {}, local = { models: [], loaded: [], loadedCtx: {} }) {
  return {
    catalog: new Map(Object.entries(catalog)),
    local,
    topFree: (n) => Object.values(catalog).filter((m) => m.free && m.tools).sort((a, b) => b.context - a.context).slice(0, n).map((m) => m.id),
    pickLocal: () => local.loaded[0] || local.models[0]?.name || null,
  }
}

test('router: auto из моделей ключей, фильтр по tools и контексту, фолбэк на локальную', () => {
  const cfg = cfgFrom({ OPENROUTER_KEY_1: 'k', OPENROUTER_MODELS_1: 'a,b,c', GW_STRATEGY: 'priority', GW_OPENROUTER_FREE_ONLY: '0' })
  const disc = fakeDiscovery(
    { a: { id: 'a', tools: false, context: 100_000 }, b: { id: 'b', tools: true, context: 1_000 }, c: { id: 'c', tools: true, context: 100_000 } },
    { models: [{ name: 'loc:8k', chat: true }], loaded: ['loc:8k'], loadedCtx: { 'loc:8k': 8192 } },
  )
  const router = new Router(cfg, new KeyPool(cfg.keys), disc)
  const need = requestNeeds({ tools: [{ type: 'function' }], messages: [] }, 12_000)
  const r = router.resolve('auto', need)
  assert.deepEqual(r.candidates.map((c) => c.model), ['c', 'loc:8k'])
  assert.ok(r.candidates[1].fallback)
  const big = router.resolve('auto', requestNeeds({ messages: [] }, 400_000))
  assert.ok(!big.candidates.some((c) => c.provider === 'local'), 'длинный запрос не уходит в узкую локальную модель')
})

test('router: без ключей auto → только локальная; local/<имя>; roundrobin вращает пул', () => {
  const disc = fakeDiscovery({}, { models: [{ name: 'q', chat: true }], loaded: [], loadedCtx: {} })
  const noKeys = new Router(cfgFrom({}), new KeyPool([]), disc)
  assert.deepEqual(noKeys.resolve('auto', requestNeeds({}, 100)).candidates.map((c) => c.provider), ['local'])
  assert.deepEqual(noKeys.resolve('local/q').candidates, [{ provider: 'local', model: 'q' }])
  const cfg = cfgFrom({ OPENROUTER_KEY_1: 'k', OPENROUTER_MODELS_1: 'a,b', GW_FALLBACK_LOCAL: '0', GW_OPENROUTER_FREE_ONLY: '0' })
  const rr = new Router(cfg, new KeyPool(cfg.keys), disc)
  assert.deepEqual([rr.resolve('auto').candidates[0].model, rr.resolve('auto').candidates[0].model], ['a', 'b'])
  assert.equal(localContext({ local: { loadedCtx: {} } }, 'x:24k'), 24 * 1024)
})

test('upstream: разбор ошибок OpenRouter, ошибка в теле 200 и в первом чанке', () => {
  const h = new Headers({ 'retry-after': '7', 'x-ratelimit-reset': '1800000000000' })
  const e = describeError(429, h, JSON.stringify({ error: { code: 429, message: 'Rate limit', metadata: { raw: 'upstream busy', provider_name: 'X' } } }))
  assert.equal(e.retryAfterMs, 7000)
  assert.equal(e.resetAt, 1800000000000)
  assert.match(e.message, /Rate limit \| upstream busy \| X/)
  assert.ok(embeddedError({ error: { code: 502, message: 'x' } }))
  assert.equal(embeddedError({ choices: [{ finish_reason: 'stop' }] }), null)
  assert.ok(firstDataError('{"error":{"code":429,"message":"busy"}}'))
  assert.equal(firstDataError('{"choices":[{"delta":{"content":"hi"}}]}'), null)
})

test('server: маршрут по суффиксу пути', () => {
  assert.equal(routePath('POST', '/v1/chat/completions'), '/chat/completions')
  assert.equal(routePath('POST', '/v1/chat/completions/chat/completions'), '/chat/completions')
  assert.equal(routePath('POST', '/v1'), '/chat/completions')
  assert.equal(routePath('GET', '/v1/models?x=1'), '/models')
  assert.equal(routePath('DELETE', '/v1/models'), null)
})

test('sync: замена своей записи VS Code без потери чужих, env-строка, блоки YAML', () => {
  const list = [{ name: 'Z.AI GLM', vendor: 'zai' }, { name: VSCODE_ENTRY_NAME, vendor: 'customendpoint', models: [] }]
  const merged = mergeVscode(list, { name: VSCODE_ENTRY_NAME, vendor: 'customendpoint', models: [1] })
  assert.equal(merged.length, 2)
  assert.deepEqual(merged[0], list[0])
  assert.deepEqual(merged[1].models, [1])
  assert.equal(upsertEnvLine('A=1\nLLM_GATEWAY_TOKEN=old\n', 'LLM_GATEWAY_TOKEN', 'new'), 'A=1\nLLM_GATEWAY_TOKEN=new\n')
  assert.equal(upsertEnvLine('A=1', 'T', 'x'), 'A=1\nT=x\n')
  const y = 'name: x\nmodels:\n  - a\ncontext:\n  - provider: code\nmcpServers:\n  - name: hub\n'
  assert.equal(topLevelBlocks(y, ['context', 'mcpServers']), 'context:\n  - provider: code\nmcpServers:\n  - name: hub')
})

test('discovery: в бесплатные пулы — только текстовые модели (не музыка/картинки), по убыванию контекста', async () => {
  const { normalizeCatalog, Discovery } = await import('../src/discovery.mjs')
  const free = { prompt: '0', completion: '0' }
  const catalog = normalizeCatalog({
    data: [
      { id: 'music', context_length: 1e6, pricing: free, architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] }, supported_parameters: ['tools'] },
      { id: 'small:free', context_length: 8_000, pricing: free, supported_parameters: ['tools'] },
      { id: 'big:free', context_length: 200_000, pricing: free, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools'] },
      { id: 'paid', context_length: 1e6, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools'] },
    ],
  })
  const d = new Discovery(cfgFrom({}), { persist: false })
  d.catalog = catalog
  assert.deepEqual(d.topFree(5), ['big:free', 'small:free'])
  assert.ok(catalog.get('big:free').vision)
})

test('config: GLM-ключи двух контуров; Coding — дефолт-лестница, General добавляется только с явным списком', () => {
  const cfg = cfgFrom({ ZAI_CODING_KEY: 'zk', ZAI_GENERAL_KEY: 'gk' })
  assert.deepEqual(cfg.keys.map((k) => k.id), ['zai-coding'], 'General без моделей не добавляется: пустой список означал бы «любая модель»')
  assert.deepEqual(cfg.keys[0].models, ['glm-4.6', 'glm-4.7', 'glm-5', 'glm-5.2'])
  assert.equal(cfg.keys[0].upstream.kind, 'glm')
  assert.match(cfg.keys[0].upstream.url, /coding\/paas\/v4$/)
  const cfg2 = cfgFrom({ ZAI_GENERAL_KEY: 'gk', GLM_MODELS_GENERAL: 'glm-4.7-flash', GLM_GENERAL_RPM: '10' })
  assert.deepEqual(cfg2.keys.map((k) => k.id), ['zai-general'])
  assert.deepEqual(cfg2.keys[0].models, ['glm-4.7-flash'])
  assert.equal(cfg2.keys[0].rpm, 10)
  assert.match(cfg2.keys[0].upstream.url, /paas\/v4$/)
  const cfg3 = cfgFrom({ ZAI_CODING_KEY: 'zk', GLM_MODELS_CODING: 'glm-4.6,glm-4.7' })
  assert.deepEqual(cfg3.keys[0].models, ['glm-4.6', 'glm-4.7'], 'явный список главнее дефолта')
})

test('keypool: upstreamFor/modelsOf разделяют провайдеров; insufficient balance — пауза всего ключа', () => {
  const cfg = cfgFrom({ OPENROUTER_KEY_1: 'or', OPENROUTER_MODELS_1: 'a,b', ZAI_CODING_KEY: 'zk', GLM_MODELS_CODING: 'glm-4.6' })
  const pool = new KeyPool(cfg.keys, { minIntervalMs: 0 })
  assert.equal(pool.upstreamFor('glm-4.6'), 'glm')
  assert.equal(pool.upstreamFor('a'), 'openrouter')
  assert.equal(pool.upstreamFor('unknown-model'), null)
  assert.deepEqual(pool.modelsOf('glm'), ['glm-4.6'])
  assert.deepEqual(pool.configuredModels(), ['a', 'b'], 'модели GLM не попадают в OpenRouter-пул auto')
  const k = pool.keys.find((x) => x.id === 'zai-coding')
  assert.equal(pool.failure(k, 'glm-4.6', { status: 429, message: 'Insufficient balance or no resource package' }), 'rotate')
  assert.ok(k.until > Date.now(), 'окно подписки исчерпано — ключ целиком на паузе')
  assert.equal(pool.acquire('glm-4.6').key, null)
})

const localModels = [
  { name: 'tiel-coder:35b-a3b-iq3s', chat: true, tools: true, vision: true, audio: false, context: 262_144, sizeBytes: 16e9 },
  { name: 'qwen2.5:7b', chat: true, tools: true, vision: false, audio: false, context: 32_768, sizeBytes: 4.7e9 },
  { name: 'deepseek-r1:7b-qwen-distill-q4_K_M', chat: true, tools: false, vision: false, audio: false, context: 32_768, sizeBytes: 4.6e9 },
  { name: 'glm4:latest', chat: true, tools: true, vision: false, audio: false, context: 131_072, sizeBytes: 7.6e9 },
  { name: 'hr-helper-embed:latest', chat: false, embedding: true, context: 2_048, sizeBytes: 0.3e9 },
]

// Потолок окна без num_ctx поднят: здесь проверяется логика тиров, а не GW_LOCAL_MAX_CONTEXT.
function localDiscovery(loaded = [], loadedCtx = {}, localMaxContext = 262_144) {
  const d = {
    cfg: { localMaxContext },
    catalog: new Map(),
    local: { models: localModels, loaded, loadedCtx },
    topFree: () => [],
    pickLocal: ({ tools, vision, audio } = {}) =>
      localModels.find((m) => m.chat && (!tools || m.tools) && (!vision || m.vision) && (!audio || m.audio))?.name || null,
  }
  return d
}

test('router: пул glm ротируется между ступенями Coding; прямой выбор glm-модели — провайдер glm', () => {
  const cfg = cfgFrom({ ZAI_CODING_KEY: 'zk' })
  const router = new Router(cfg, new KeyPool(cfg.keys), localDiscovery())
  const first = router.resolve('glm').candidates
  assert.deepEqual(first.map((c) => c.provider), ['glm', 'glm', 'glm', 'glm'])
  const second = router.resolve('glm').candidates
  assert.notEqual(first[0].model, second[0].model, 'roundrobin начинает со следующей модели')
  const direct = router.resolve('glm-5.2').candidates
  assert.equal(direct[0].provider, 'glm')
  assert.equal(direct[0].model, 'glm-5.2')
  assert.equal(direct[1]?.fallback, true, 'как и у OpenRouter-моделей — локальный фолбэк замыкает список')
})

test('router: cascade = OpenRouter → GLM → local; local — по возможностям запроса', () => {
  const cfg = cfgFrom({ OPENROUTER_KEY_1: 'or', OPENROUTER_MODELS_1: 'a:free,b:free', ZAI_CODING_KEY: 'zk' })
  const router = new Router(cfg, new KeyPool(cfg.keys), localDiscovery())
  const cascade = router.resolve('cascade', requestNeeds({ messages: [] }, 100)).candidates.map((c) => c.provider)
  assert.deepEqual(cascade.slice(0, 2), ['openrouter', 'openrouter'])
  const or = cascade.indexOf('openrouter')
  const glm = cascade.indexOf('glm')
  const loc = cascade.indexOf('local')
  assert.ok(or === 0 && glm > or && loc > glm, 'порядок групп: OR → GLM → local')
  const vision = router.resolve('local', requestNeeds({ messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }, 100)).candidates
  assert.deepEqual(vision.map((c) => c.model), ['tiel-coder:35b-a3b-iq3s'], 'vision-запрос идёт только к vision-моделям')
  const tools = router.resolve('local', requestNeeds({ tools: [1] }, 100)).candidates.map((c) => c.model)
  assert.ok(!tools.includes('deepseek-r1:7b-qwen-distill-q4_K_M'), 'без tools-поддержки в tools-запрос не идёт')
})

test('router: тиры local/code|reason|long|fast — авто и явные списки', () => {
  const cfg = cfgFrom({})
  const router = new Router(cfg, new KeyPool([]), localDiscovery())
  assert.deepEqual(router.resolve('local/code').candidates.map((c) => c.model), ['tiel-coder:35b-a3b-iq3s'])
  assert.deepEqual(router.resolve('local/reason').candidates.map((c) => c.model), ['deepseek-r1:7b-qwen-distill-q4_K_M'])
  assert.deepEqual(router.resolve('local/long').candidates.map((c) => c.model).sort(), ['glm4:latest', 'tiel-coder:35b-a3b-iq3s'])
  assert.deepEqual(router.resolve('local/fast').candidates.map((c) => c.model).sort(), ['deepseek-r1:7b-qwen-distill-q4_K_M', 'qwen2.5:7b'])
  const cfg2 = cfgFrom({ GW_LOCAL_CODE: 'qwen2.5:7b,нет-такой' })
  const router2 = new Router(cfg2, new KeyPool([]), localDiscovery())
  assert.deepEqual(router2.resolve('local/code').candidates.map((c) => c.model), ['qwen2.5:7b'], 'явный список главнее авто, отсутствующие отсеиваются')
  const audio = router.resolve('local', requestNeeds({ messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] }, 100)).candidates
  assert.equal(audio.length, 0, 'audio-запросов без audio-моделей нет — клиенту 503, а не ложный ответ')
})

test('router: localContext видит контекст из /api/tags, а не только тег-подсказку', () => {
  assert.equal(localContext(localDiscovery(), 'glm4:latest'), 131_072)
  assert.equal(localContext(localDiscovery([], {}, 32_768), 'glm4:latest'), 32_768, 'без num_ctx — не больше GW_LOCAL_MAX_CONTEXT')
  assert.equal(localContext(localDiscovery(['glm46v:24k'], { 'glm46v:24k': 13_900 }), 'glm46v:24k'), 13_900, 'фактический загруженный главнее')
  assert.equal(localContext(localDiscovery(), 'x:24k'), 24 * 1024)
  assert.equal(localContext(localDiscovery(), 'x'), 4_096)
})

// 2026-10-29: 402 «You requested up to 131072 tokens, but can only afford 4490» — платная модель и завышенный max_tokens.
test('router: free-only — платная модель OpenRouter не уходит ни из пула, ни прямым выбором', () => {
  const cfg = cfgFrom({ OPENROUTER_KEY_1: 'or', OPENROUTER_MODELS_1: 'x/paid,x/paid:free,x/a:free,x/b:free,x/zero', GW_STRATEGY: 'priority' })
  const disc = fakeDiscovery({
    'x/paid': { id: 'x/paid', free: false, tools: true },
    'x/paid:free': { id: 'x/paid:free', free: true, tools: true },
    'x/zero': { id: 'x/zero', free: true, tools: true },
  })
  const router = new Router(cfg, new KeyPool(cfg.keys), disc)
  const auto = router.resolve('auto').candidates.filter((c) => !c.fallback).map((c) => c.model)
  assert.deepEqual(auto, ['x/paid:free', 'x/a:free', 'x/b:free', 'x/zero'], 'платная из OPENROUTER_MODELS_1 выпала, нулевая цена по каталогу осталась')
  const paid = router.resolve('x/paid').candidates.filter((c) => !c.fallback).map((c) => c.model)
  assert.equal(paid[0], 'x/paid:free', 'платная с бесплатным вариантом → вариант :free первым')
  assert.ok(!paid.includes('x/paid'))
  const unknown = router.resolve('vendor/other-paid').candidates.filter((c) => !c.fallback)
  assert.ok(unknown.length && unknown.every((c) => c.backup && c.model !== 'vendor/other-paid'), 'неизвестная платная → сразу пул free')
  const off = new Router(cfgFrom({ OPENROUTER_KEY_1: 'or', GW_OPENROUTER_FREE_ONLY: '0' }), new KeyPool(cfg.keys), disc)
  assert.equal(off.resolve('x/paid').candidates[0].model, 'x/paid', 'GW_OPENROUTER_FREE_ONLY=0 — платные снова можно')
})

test('router: прямо выбранная free-модель первой, за ней запасные из пула free, затем локальная', () => {
  const cfg = cfgFrom({ OPENROUTER_KEY_1: 'or', OPENROUTER_MODELS_1: 'x/a:free,x/b:free,x/c:free' })
  const disc = fakeDiscovery({}, { models: [{ name: 'loc', chat: true }], loaded: ['loc'], loadedCtx: { loc: 32_768 } })
  const r = new Router(cfg, new KeyPool(cfg.keys), disc).resolve('x/b:free', requestNeeds({ messages: [] }, 100))
  assert.deepEqual(r.candidates.map((c) => c.model).sort(), ['loc', 'x/a:free', 'x/b:free', 'x/c:free'])
  assert.equal(r.candidates[0].model, 'x/b:free')
  assert.ok(r.candidates.slice(1, 3).every((c) => c.backup))
  assert.ok(r.candidates[3].fallback)
})

test('upstream: потолок max_tokens / max_completion_tokens; меньший запрос и отсутствие поля — как есть', () => {
  assert.deepEqual(clampOutput({ max_tokens: 131_072, max_completion_tokens: 99_999, x: 1 }, 32_768), { max_tokens: 32_768, max_completion_tokens: 32_768, x: 1 })
  assert.deepEqual(clampOutput({ max_tokens: 1_000 }, 32_768), { max_tokens: 1_000 })
  assert.deepEqual(clampOutput({ messages: [] }, 32_768), { messages: [] }, 'потолок не добавляется, если клиент его не просил')
  assert.deepEqual(clampOutput({ max_tokens: 131_072 }, Infinity), { max_tokens: 131_072 })
  const proxy = new Proxy({ cfg: cfgFrom({}), discovery: fakeDiscovery({ 'm:free': { id: 'm:free', maxOutput: 8_192 } }) })
  assert.equal(proxy.outputCap({ provider: 'openrouter', model: 'm:free' }), 8_192, 'максимум модели по каталогу ниже общего потолка')
  assert.equal(proxy.outputCap({ provider: 'openrouter', model: 'unknown:free' }), 32_768)
  assert.equal(proxy.outputCap({ provider: 'local', model: 'q' }), Infinity)
})

test('discovery: /key OpenRouter опрашивается только ключами OpenRouter — ключ Z.AI туда не уходит', async () => {
  const seen = []
  const fetchImpl = async (url, init) => (seen.push(init.headers.Authorization), { ok: true, json: async () => ({ data: { label: 'l' } }) })
  const cfg = cfgFrom({ OPENROUTER_KEY_1: 'or-key', ZAI_CODING_KEY: 'zai-key' })
  const info = await new Discovery(cfg, { fetchImpl, persist: false }).refreshKeyInfo(cfg.keys, { force: true })
  assert.deepEqual(seen, ['Bearer or-key'])
  assert.deepEqual([...info.keys()], ['or1'])
})

test('sync: имена моделей постоянные (без числа участников), автокомплит/эмбеддинги Continue — только установленные', () => {
  const cfg = cfgFrom({ OPENROUTER_KEY_1: 'or', OPENROUTER_MODELS_1: 'x/a:free,x/paid', ZAI_CODING_KEY: 'zk' })
  const local = { models: [{ name: 'q:8k', chat: true, tools: true }, { name: 'tiel-coder-fim:latest', chat: true }], loaded: [], loadedCtx: {} }
  const disc = fakeDiscovery({ 'x/a:free': { id: 'x/a:free', name: 'Vendor: A (free)', context: 128_000, tools: true } }, local)
  const pool = new KeyPool(cfg.keys)
  const models = clientModels({ cfg, pool, router: new Router(cfg, pool, disc), discovery: disc })
  const ids = models.map((m) => m.id)
  assert.ok(ids.includes('x/a:free') && !ids.includes('x/paid'), 'платная модель клиентам не предлагается')
  assert.ok(models.every((m) => !/\d+ мод\./.test(m.name)), 'в именах нет счётчиков')
  assert.equal(models.find((m) => m.id === 'x/a:free').name, 'GW x/a:free')
  const roles = continueLocalRoles(cfg, disc)
  assert.equal(roles.length, 1, 'эмбеддинг-модели нет в Ollama — роль embed не пишем')
  assert.match(roles[0], /provider: ollama[\s\S]*- autocomplete/)
  assert.match(continueYaml(cfg, models, '', roles), /tiel-coder-fim:latest/)
})

test('proxy: /completions (FIM) не уходит в GLM — у Z.AI такого эндпоинта нет', () => {
  const cands = [{ provider: 'glm', model: 'glm-4.6' }, { provider: 'openrouter', model: 'a:free' }, { provider: 'local', model: 'q' }]
  assert.deepEqual(cands.filter(servesPath('/completions')).map((c) => c.provider), ['openrouter', 'local'])
  assert.equal(cands.filter(servesPath('/chat/completions')).length, 3)
  // Выбран GLM на FIM: локальный фолбэк не подставляется (чатовый ответ вместо дополнения + смена модели в Ollama).
  const glmOnly = { candidates: [{ provider: 'glm', model: 'glm-4.7' }, { provider: 'local', model: 'q', fallback: true }] }
  const fim = pathCandidates(glmOnly, '/completions')
  assert.deepEqual(fim.candidates, [])
  assert.match(fim.reason, /FIM/)
  assert.equal(pathCandidates(glmOnly, '/chat/completions').candidates.length, 2)
  // В смешанном пуле на FIM остаются не-GLM кандидаты и фолбэк.
  const mixed = { candidates: [...cands, { provider: 'local', model: 'z', fallback: true }] }
  assert.deepEqual(pathCandidates(mixed, '/completions').candidates.map((c) => c.model), ['a:free', 'q', 'z'])
})

test('upstream: models[] и plugins не уходят в апстрим при free-only; max_tokens строкой и бюджет рассуждений', () => {
  const cfg = cfgFrom({})
  const body = { model: 'a:free', models: ['anthropic/claude-opus-4'], plugins: [{ id: 'web' }], max_tokens: '131072', reasoning: { max_tokens: 64_000 }, messages: [] }
  const sent = JSON.parse(buildRequest(cfg, { provider: 'openrouter', model: 'a:free' }, { key: 'k' }, '/chat/completions', body, 'application/json', 32_768).init.body)
  assert.equal(sent.models, undefined)
  assert.equal(sent.plugins, undefined)
  assert.equal(sent.max_tokens, 32_768)
  assert.ok(sent.reasoning.max_tokens < sent.max_tokens, 'иначе апстрим ответит 400')
  const paid = JSON.parse(buildRequest(cfgFrom({ GW_OPENROUTER_FREE_ONLY: '0' }), { provider: 'openrouter', model: 'x' }, { key: 'k' }, '/chat/completions', body, 'application/json').init.body)
  assert.deepEqual(paid.plugins, [{ id: 'web' }], 'без free-only плагины разрешены')
  assert.equal(paid.models, undefined, 'запасные выбирает шлюз, не OpenRouter')
})

test('keypool: ключ OpenRouter с пустым списком моделей не берёт запрос к GLM', () => {
  const cfg = cfgFrom({ OPENROUTER_KEY_1: 'k', ZAI_CODING_KEY: 'z' })
  const pool = new KeyPool(cfg.keys)
  assert.equal(pool.acquire('glm-4.6', 'glm').key.id, 'zai-coding')
  assert.equal(pool.acquire('glm-4.6', 'openrouter').key.id, 'or1', 'без фильтра провайдера ключ «разрешает всё»')
})

test('router: пул из одних платных при free-only получает запасные из free, servable скрывает платные', () => {
  const cfg = cfgFrom({ OPENROUTER_KEY_1: 'k', OPENROUTER_MODELS_1: 'x/paid,a:free', GW_ALIAS_TEAM: 'x/paid', GW_LOCAL: '0' })
  const router = new Router(cfg, new KeyPool(cfg.keys), fakeDiscovery({ 'a:free': { id: 'a:free', free: true, tools: true, context: 100_000 } }))
  const r = router.resolve('team', requestNeeds({ messages: [] }, 10))
  assert.deepEqual(r.candidates.map((c) => [c.model, !!c.backup]), [['a:free', true]])
  assert.equal(router.servable('x/paid'), false)
  assert.equal(router.servable('a:free'), true)
})

test('local: окно — num_ctx из Modelfile, без него — не больше GW_LOCAL_MAX_CONTEXT; local/auto длинный запрос не отдаёт маленькой', async () => {
  const tags = { models: [
    { name: 'small:latest', digest: 'd1', capabilities: ['completion', 'tools'], details: { context_length: 262_144 } },
    { name: 'big:latest', digest: 'd2', capabilities: ['completion', 'tools'], details: { context_length: 131_072 } },
    { name: 'coder-fim:latest', digest: 'd3', capabilities: ['completion'], details: { context_length: 262_144 } },
  ] }
  const show = { 'small:latest': 'num_ctx 4096', 'big:latest': 'num_ctx 65536', 'coder-fim:latest': 'num_ctx 8192\nnum_predict 64' }
  const fetchImpl = async (url, init) => ({
    ok: true,
    json: async () => (url.endsWith('/api/tags') ? tags : url.endsWith('/api/ps') ? { models: [{ name: 'small:latest', context_length: 4096 }] } : { parameters: show[JSON.parse(init.body).model] }),
  })
  const cfg = cfgFrom({ GW_LOCAL_MAX_CONTEXT: '16384' })
  const d = new Discovery(cfg, { fetchImpl, persist: false })
  await d.refreshLocal({ force: true })
  assert.deepEqual(d.local.models.filter((m) => m.chat).map((m) => m.name), ['small:latest', 'big:latest'], 'FIM-модель в чат не берём')
  assert.equal(localContext(d, 'big:latest'), 65_536)
  d.local.models.find((m) => m.name === 'big:latest').numCtx = 0
  assert.equal(localContext(d, 'big:latest'), 16_384, 'без num_ctx — потолок GW_LOCAL_MAX_CONTEXT')
  d.local.models.find((m) => m.name === 'big:latest').numCtx = 65_536
  const router = new Router(cfg, new KeyPool([]), d)
  assert.equal(router.resolve('local/auto', requestNeeds({ messages: [] }, 10)).candidates[0].model, 'small:latest', 'короткий — загруженной')
  const long = requestNeeds({ messages: [{ role: 'user', content: 'x'.repeat(120_000) }] }, 120_000)
  assert.equal(router.resolve('local/auto', long).candidates[0].model, 'big:latest', 'длинный — той, в чьё окно влезает')
})

test('localBody: рассуждения снимаются только у локальной модели, про которую известно, что thinking нет', () => {
  const body = { model: 'x', messages: [], reasoning_effort: 'max', include_reasoning: true, reasoning: { effort: 'high' }, max_tokens: 5 }
  assert.deepEqual(localBody(body, { thinking: false }), { model: 'x', messages: [], max_tokens: 5 })
  assert.equal(body.reasoning_effort, 'max') // тело клиента не мутируется: следующий кандидат получит его целым
  assert.equal(localBody(body, { thinking: true }), body)
  assert.equal(localBody(body, { thinking: null }), body) // Ollama возможностей не сообщила — не гадаем
  assert.equal(localBody(body, undefined), body)
  const bare = { model: 'x', messages: [] }
  assert.equal(localBody(bare, { thinking: false }), bare)
})

test('router: «нет thinking» локальной модели фиксируется на кандидате при выборе', () => {
  const disc = fakeDiscovery({}, { models: [{ name: 'plain', chat: true, thinking: false }, { name: 'deep', chat: true, thinking: true }, { name: 'unk', chat: true, thinking: null }], loaded: [], loadedCtx: {} })
  const router = new Router(cfgFrom({}), new KeyPool([]), disc)
  assert.deepEqual(router.resolve('local/plain').candidates, [{ provider: 'local', model: 'plain', thinking: false }])
  assert.deepEqual(router.resolve('local/deep').candidates, [{ provider: 'local', model: 'deep' }])
  assert.deepEqual(router.resolve('local/unk').candidates, [{ provider: 'local', model: 'unk' }])
  // Список моделей обнулился неудачным refreshLocal уже после выбора — кандидат помнит, что thinking нет.
  const [cand] = router.resolve('local/plain').candidates
  disc.local.models = []
  assert.deepEqual(localBody({ messages: [], reasoning_effort: 'max' }, cand), { messages: [] })
})
