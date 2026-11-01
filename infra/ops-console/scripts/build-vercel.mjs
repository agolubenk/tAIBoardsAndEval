/**
 * Сборка для Vercel в формате Build Output API v3 (.vercel/output) — без догадок платформы:
 *   static/            — SPA (vite build)
 *   functions/api.func — весь /api/* одним бандлом (esbuild), libSQL через web-клиент
 *                        (fetch к Turso, без нативных бинарников)
 *   config.json        — маршруты (/api → функция, остальное → SPA) и Vercel Cron
 * Миграции на Turso — до сборки: `npm run db:migrate` (см. vercel.json buildCommand).
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, '.vercel/output')
const fn = join(out, 'functions/api.func')

await rm(out, { recursive: true, force: true })
execSync('npx vite build', { cwd: root, stdio: 'inherit' })
await mkdir(join(out, 'static'), { recursive: true })
await cp(join(root, 'dist'), join(out, 'static'), { recursive: true })

await mkdir(fn, { recursive: true })
await build({
  entryPoints: [join(root, 'server/vercel.ts')],
  outfile: join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // nodemailer и прочие CJS-зависимости внутри ESM-бандла ждут require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  alias: { '@libsql/client': '@libsql/client/web' },
  legalComments: 'none',
  logLevel: 'warning',
})
await writeFile(
  join(fn, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 30,
    },
    null,
    2,
  ),
)
await writeFile(join(fn, 'package.json'), JSON.stringify({ type: 'module' }))

await writeFile(
  join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/api(/.*)?$', dest: '/api' },
        { src: '^/assets/(.*)$', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }, continue: true },
        { handle: 'filesystem' },
        { src: '^/(.*)$', dest: '/index.html', headers: { 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex' } },
      ],
      // Hobby-план Vercel: cron не чаще раза в сутки — этого хватает на дайджест и отчёт ИИ-совету.
      // Минутные проверки: попутно из отчётов агента + внешний пингер (README).
      crons: [{ path: '/api/cron/tick', schedule: '0 6 * * *' }],
    },
    null,
    2,
  ),
)
console.log('[ops] .vercel/output готов')
