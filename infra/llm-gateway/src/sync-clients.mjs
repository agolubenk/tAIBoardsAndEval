// Прописывает шлюз в клиентов: чат VS Code (chatLanguageModels.json, vendor customendpoint) и Continue
// (.continue/agents/llm-gateway.yaml + LLM_GATEWAY_TOKEN в .continue/.env). Перед правкой — копия файла.
// Запуск: node src/sync-clients.mjs [--dry-run]
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, REPO_ROOT, STATE_DIR } from './config.mjs'
import { KeyPool } from './keypool.mjs'
import { Discovery } from './discovery.mjs'
import { Router, localContext, LOCAL_TIERS } from './router.mjs'

export const VSCODE_ENTRY_NAME = 'HR Gateway'
const VSCODE_FILE = join(homedir(), 'Library/Application Support/Code/User/chatLanguageModels.json')
const POOL_OUTPUT = 8192

// Описание моделей для клиентов. Пул: окно — наибольшее среди участников (шлюз сам не отдаст запрос модели,
// которой он не влезет), vision/tools — если умеет хоть один.
// Имена постоянные — без числа участников и без имени из каталога: Continue запоминает выбор по имени,
// и «ротация 15 мод.» → «ротация 16 мод.» после смены каталога сбрасывала выбранную модель.
const GLM_META = { tools: true, vision: false, context: 128_000, output: 16_384 }
const POOL_TITLES = { auto: 'GW auto · ротация OpenRouter', free: 'GW free · ротация только :free' }

export function clientModels({ cfg, pool, router, discovery }) {
  const out = []
  const meta = (id) => discovery.catalog.get(id)
  for (const name of router.poolNames()) {
    if (name === 'cascade') {
      out.push({ id: 'cascade', name: 'GW cascade · OR → GLM → local', tools: true, vision: true, context: 128_000, output: POOL_OUTPUT })
      continue
    }
    if (name === 'glm') {
      if (!router.glmModels().length) continue
      out.push({ id: 'glm', name: 'GW glm · ротация GLM', ...GLM_META })
      continue
    }
    const members = (router.poolModels(name) || []).filter((id) => router.servable(id))
    if (!members.length && !cfg.fallbackLocal) continue
    const known = members.map(meta).filter(Boolean)
    out.push({
      id: name,
      name: POOL_TITLES[name] || `GW ${name} · ротация`,
      tools: known.length ? known.some((m) => m.tools) : true,
      vision: known.some((m) => m.vision),
      context: Math.max(32_768, ...known.map((m) => m.context || 0)),
      output: POOL_OUTPUT,
    })
  }
  for (const id of pool.configuredModels().filter((x) => router.orAllowed(x))) {
    const m = meta(id)
    out.push({
      id,
      name: `GW ${id}`,
      tools: m ? m.tools : true,
      vision: !!m?.vision,
      context: m?.context || 65_536,
      output: Math.min(m?.maxOutput || POOL_OUTPUT, 32_768),
    })
  }
  // Каждая GLM-модель и отдельно — ручной выбор конкретной ступени (лестница правила 04).
  for (const id of pool.modelsOf('glm')) out.push({ id, name: `GW GLM ${id.replace(/^glm-/, '')}`, ...GLM_META })
  if (cfg.localEnabled) {
    const chat = discovery.local.models.filter((m) => m.chat)
    if (chat.length) {
      // Окно локального пула — наибольшее среди моделей, как у облачных пулов: при 8 192 чат VS Code оставлял
      // запросу 4 096 токенов и резал историю. Запрос, который не влезет ни в одну, шлюз отклонит, а не обрежет.
      const ctxOf = (names) => Math.max(8_192, ...names.map((n) => localContext(discovery, n)))
      const pooled = (names) => ({ tools: chat.some((m) => m.tools), vision: chat.some((m) => m.vision), context: ctxOf(names), output: 4_096, local: true })
      const all = chat.map((m) => m.name)
      out.push({ id: 'local/auto', name: 'GW local/auto · загруженная сейчас', ...pooled(all) })
      out.push({ id: 'local', name: 'GW local · ротация по возможностям', ...pooled(all) })
      for (const tier of LOCAL_TIERS) {
        const members = router.localTierModels(tier, {})
        if (!members.length) continue
        out.push({ id: `local/${tier}`, name: `GW local/${tier}`, ...pooled(members.map((id) => id.slice('local/'.length))) })
      }
      for (const m of chat) {
        const ctx = localContext(discovery, m.name)
        out.push({ id: `local/${m.name}`, name: `GW local ${m.name}`, tools: m.tools, vision: m.vision, context: ctx, output: Math.min(4_096, Math.floor(ctx / 4)), local: true })
      }
    }
  }
  return out
}

export function vscodeEntry(cfg, models) {
  const url = `http://${cfg.host}:${cfg.port}/v1/chat/completions`
  return {
    name: VSCODE_ENTRY_NAME,
    vendor: 'customendpoint',
    apiKey: cfg.token,
    apiType: 'chat-completions',
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      url,
      apiType: 'chat-completions',
      toolCalling: !!m.tools,
      vision: !!m.vision,
      maxInputTokens: Math.max(1_024, m.context - m.output),
      maxOutputTokens: m.output,
    })),
  }
}

export function mergeVscode(list, entry) {
  const rest = (Array.isArray(list) ? list : []).filter((e) => !(e?.name === VSCODE_ENTRY_NAME && e?.vendor === 'customendpoint'))
  return [...rest, entry]
}

// Блоки верхнего уровня из основного конфига Continue (контекст, MCP, разрешения) — чтобы у ассистента шлюза
// были те же инструменты. YAML режем по строкам верхнего уровня: зависимостей у пакета нет намеренно.
export function topLevelBlocks(yaml, keys) {
  const lines = yaml.split('\n')
  const out = []
  let keep = false
  for (const line of lines) {
    const m = /^([A-Za-z_][\w-]*):/.exec(line)
    if (m) keep = keys.includes(m[1])
    if (keep) out.push(line)
  }
  return out.join('\n').trimEnd()
}

const q = (s) => JSON.stringify(s)

// Автокомплит и эмбеддинги — напрямую в Ollama, мимо шлюза: FIM идёт на /completions, которого нет у Z.AI
// (отсюда был 404 автокомплита), а облачный FIM в бесплатных пулах OpenRouter ненадёжен.
export function continueLocalRoles(cfg, discovery) {
  const have = new Set(discovery.local.models.map((m) => m.name))
  const rows = []
  if (cfg.localEnabled && cfg.continueAutocomplete && have.has(cfg.continueAutocomplete)) {
    rows.push(
      [
        `  - name: ${q(`Local autocomplete · ${cfg.continueAutocomplete}`)}`,
        '    provider: ollama',
        `    model: ${q(cfg.continueAutocomplete)}`,
        `    apiBase: ${cfg.ollamaUrl}`,
        '    roles:',
        '      - autocomplete',
        // Параметры — из проверенного блока .continue/agents/config.yaml (коммит 98be5da3f).
        '    defaultCompletionOptions:',
        '      temperature: 0.05',
        '      maxTokens: 64',
        '    autocompleteOptions:',
        '      maxPromptTokens: 1536',
        '      debounceDelay: 350',
        '      modelTimeout: 15000',
        '      onlyMyCode: true',
        '      useCache: true',
      ].join('\n'),
    )
  }
  if (cfg.localEnabled && cfg.continueEmbed && have.has(cfg.continueEmbed)) {
    rows.push(
      [
        `  - name: ${q(`Local embed · ${cfg.continueEmbed}`)}`,
        '    provider: ollama',
        `    model: ${q(cfg.continueEmbed)}`,
        `    apiBase: ${cfg.ollamaUrl}`,
        '    roles:',
        '      - embed',
        // Малые пачки: индексация не держит Ollama занятой длинными батчами (как в .continue/config.yaml).
        '    embedOptions:',
        '      maxBatchSize: 8',
        '      maxChunkSize: 512',
      ].join('\n'),
    )
  }
  return rows
}

export function continueYaml(cfg, models, sharedBlocks, localRoles = []) {
  const apiBase = `http://${cfg.host}:${cfg.port}/v1/`
  const rows = models.map((m) => {
    const caps = [m.tools && 'tool_use', m.vision && 'image_input'].filter(Boolean)
    return [
      `  - name: ${q(m.name)}`,
      '    provider: openai',
      `    model: ${q(m.id)}`,
      `    apiBase: ${apiBase}`,
      '    apiKey: ${{ secrets.LLM_GATEWAY_TOKEN }}',
      '    roles:',
      '      - chat',
      '      - edit',
      '      - apply',
      ...(caps.length ? ['    capabilities:', ...caps.map((c) => `      - ${c}`)] : []),
      `    contextLength: ${m.context}`,
      '    defaultCompletionOptions:',
      `      maxTokens: ${m.output}`,
      '    requestOptions:',
      '      timeout: 600000',
    ].join('\n')
  })
  return [
    '# СГЕНЕРИРОВАНО `npm run llm-gateway:sync` — руками не править, перезапишется. Gitignored.',
    '# Все модели идут через локальный шлюз infra/llm-gateway: ротация ключей OpenRouter и моделей,',
    '# GLM Z.AI (подписка Coding), локальная Ollama; пул cascade проходит все три по очереди.',
    '# Ключ — токен шлюза из .continue/.env, ключи OpenRouter/Z.AI сюда не попадают.',
    'name: HR Gateway — OpenRouter + GLM + локальные (ротация)',
    'version: 0.1.0',
    'schema: v1',
    '',
    'models:',
    [...rows, ...localRoles].join('\n\n'),
    '',
    sharedBlocks,
    '',
  ].join('\n')
}

export function upsertEnvLine(text, key, value) {
  const line = `${key}=${value}`
  const re = new RegExp(`^${key}=.*$`, 'm')
  if (re.test(text)) return text.replace(re, line)
  return `${text.replace(/\n*$/, text ? '\n' : '')}${line}\n`
}

// Запись только при изменении: перезапись того же списка заставляет VS Code заново регистрировать модели
// провайдера, и выбранная в чате модель может слететь на модель по умолчанию.
function writeIfChanged(file, text, opts) {
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return false
  writeFileSync(file, text, opts)
  return true
}

function backup(file) {
  if (!existsSync(file)) return null
  const dir = join(STATE_DIR, 'backups')
  mkdirSync(dir, { recursive: true })
  const to = join(dir, `${file.split('/').pop()}.${new Date().toISOString().replace(/[:.]/g, '-')}`)
  copyFileSync(file, to)
  chmodSync(to, 0o600)
  return to
}

export async function sync({ dryRun = false, cfg = loadConfig(), repoRoot = REPO_ROOT, vscodeFile = VSCODE_FILE } = {}) {
  const pool = new KeyPool(cfg.keys)
  const discovery = new Discovery(cfg)
  const router = new Router(cfg, pool, discovery)
  await discovery.refreshCatalog()
  await discovery.refreshLocal({ force: true })
  const models = clientModels({ cfg, pool, router, discovery })
  const report = { models: models.map((m) => m.id), written: [] }

  const entry = vscodeEntry(cfg, models)
  const current = existsSync(vscodeFile) ? JSON.parse(readFileSync(vscodeFile, 'utf8')) : []
  const merged = `${JSON.stringify(mergeVscode(current, entry), null, '\t')}\n`

  const continueDir = join(repoRoot, '.continue')
  const baseCfg = join(continueDir, 'config.yaml')
  const shared = existsSync(baseCfg) ? topLevelBlocks(readFileSync(baseCfg, 'utf8'), ['context', 'mcpServers', 'permissions']) : ''
  const agentFile = join(continueDir, 'agents', 'llm-gateway.yaml')
  const envFile = join(continueDir, '.env')
  const envText = upsertEnvLine(existsSync(envFile) ? readFileSync(envFile, 'utf8') : '', 'LLM_GATEWAY_TOKEN', cfg.token)

  if (dryRun) return { ...report, dryRun: true }
  const same = (file, text) => existsSync(file) && readFileSync(file, 'utf8') === text
  report.backups = [same(vscodeFile, merged) ? null : backup(vscodeFile), same(envFile, envText) ? null : backup(envFile)].filter(Boolean)
  report.unchanged = []
  const put = (file, text, opts) => (writeIfChanged(file, text, opts) ? report.written : report.unchanged).push(file)
  put(vscodeFile, merged)
  mkdirSync(join(continueDir, 'agents'), { recursive: true })
  put(agentFile, continueYaml(cfg, models, shared, continueLocalRoles(cfg, discovery)))
  put(envFile, envText, { mode: 0o600 })
  if (existsSync(envFile)) chmodSync(envFile, 0o600) // mode при записи действует только на новый файл, а в .continue/.env лежат и чужие ключи
  return report
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  sync({ dryRun: process.argv.includes('--dry-run') })
    .then((r) => {
      console.log(`[llm-gateway sync] моделей: ${r.models.length} → ${r.models.join(', ')}`)
      for (const f of r.written) console.log(`  записан: ${f}`)
      for (const f of r.unchanged || []) console.log(`  без изменений: ${f}`)
      for (const f of r.backups || []) console.log(`  копия:   ${f}`)
      if (r.dryRun) console.log('  --dry-run: ничего не записано')
    })
    .catch((err) => {
      console.error(`[llm-gateway sync] ошибка: ${err.message}`)
      process.exit(1)
    })
}
