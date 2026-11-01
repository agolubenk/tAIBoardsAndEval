// Короткий отчёт о работающем шлюзе: `node src/cli.mjs status|models|ask "<текст>" [модель]`.
import { loadConfig } from './config.mjs'

const cfg = loadConfig()
const base = `http://${cfg.host}:${cfg.port}`
const headers = { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }
const sec = (ms) => (ms ? `${Math.ceil(ms / 1000)} с` : '—')

async function get(path) {
  const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return res.json()
}

async function status() {
  const s = await get('/stats')
  console.log(`шлюз ${base}/v1 · аптайм ${s.uptimeS} с · стратегия ${s.strategy}`)
  console.log(`запросы: ${s.counters.requests} · ок ${s.counters.ok} · отказ ${s.counters.failed} · попыток ${s.counters.attempts} · фолбэк на локальную ${s.counters.localFallbacks}`)
  if (!s.keys.length) console.log('ключи OpenRouter: не заданы (только локальные модели) — впиши OPENROUTER_KEY_1..3 в infra/llm-gateway/.env')
  for (const k of s.keys) {
    const info = k.info?.error ? `ошибка /key: ${k.info.error}` : k.info ? `остаток ${k.info.limitRemaining ?? '∞'} · расход ${k.info.usage ?? '?'} · free-tier ${k.info.isFreeTier}` : 'инфо ещё нет'
    const pauses = [k.disabledForMs && `выключен ${sec(k.disabledForMs)}`, k.freePausedForMs && `free на паузе ${sec(k.freePausedForMs)}`, k.paidPausedForMs && `платные на паузе ${sec(k.paidPausedForMs)}`]
      .filter(Boolean)
      .join(', ')
    console.log(`  ${k.id} ${k.masked} · ${k.rpm} rpm (запас ${k.tokens ?? '∞'}) · ок ${k.ok}/отказ ${k.failed} · ${info}${pauses ? ` · ${pauses}` : ''}`)
    console.log(`     модели: ${k.models.length ? k.models.join(', ') : 'любые'}`)
    for (const p of k.modelPauses) console.log(`     пауза ${p.model}: ${sec(p.forMs)}`)
    if (k.lastError) console.log(`     последняя ошибка: ${k.lastError.status} ${k.lastError.model} ${k.lastError.message}`)
  }
  console.log(`каталог OpenRouter: ${s.catalog.models} моделей${s.catalog.error ? ` · ошибка ${s.catalog.error}` : ''}`)
  console.log(`Ollama ${s.local.url}: ${s.local.error ? `недоступна (${s.local.error})` : `${s.local.models.length} моделей, в памяти: ${s.local.loaded.join(', ') || 'ничего'}`}`)
  console.log(`очередь: облако ${s.queue.remoteActive} в работе / ${s.queue.remoteWaiting} ждут · локально ${s.queue.localActive} / ${s.queue.localWaiting}`)
}

async function models() {
  const { data } = await get('/v1/models')
  for (const m of data) {
    const extra = m.pool ? ` → ${m.pool.join(', ') || '(пусто, фолбэк на локальную)'}` : m.loaded ? ' · в памяти' : ''
    console.log(`${m.id}${m.context_length ? ` · ${m.context_length} ток.` : ''}${extra}`)
  }
}

async function ask(text, model = 'auto') {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], max_tokens: 1024 }),
  })
  const j = await res.json()
  console.log(`HTTP ${res.status} · модель ${res.headers.get('x-gateway-model')} · ключ ${res.headers.get('x-gateway-key')} · попыток ${res.headers.get('x-gateway-attempts')}`)
  const msg = j.choices?.[0]?.message
  // Думающие модели могут потратить весь лимит на рассуждение — тогда покажем его хвост, а не пустоту.
  if (msg) console.log(msg.content || `(ответ пуст; рассуждение: …${String(msg.reasoning || msg.reasoning_content || '').slice(-300)})`)
  else console.log(JSON.stringify(j).slice(0, 500))
}

const [cmd = 'status', ...args] = process.argv.slice(2)
const run = { status, models, ask: () => ask(args[0] || 'Ответь одним словом: работает?', args[1]) }[cmd]
if (!run) {
  console.error('команды: status | models | ask "<текст>" [модель]')
  process.exit(2)
}
run().catch((err) => {
  console.error(`[llm-gateway] ${err.cause?.code === 'ECONNREFUSED' ? 'шлюз не запущен — npm run llm-gateway:start' : err.message}`)
  process.exit(1)
})
