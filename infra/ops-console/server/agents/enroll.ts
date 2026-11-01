/**
 * Подключение сервера одноразовым кодом (как в прототипе): владелец получает команду
 *   curl -fsSL https://<консоль>/agent/install.sh | sudo OPS_ENROLL_CODE=<код> bash
 * Скрипт скачивает файлы агента с этой же консоли (сверяя sha256), меняет код на секрет агента и
 * запускает службу. Код — 32 символа base64url, живёт 15 минут, действует один раз; в базе только
 * его sha256. Обмен выпускает НОВЫЙ секрет (прежний, показанный при создании, перестаёт работать) —
 * секрет агента так и не проходит через браузер. Подбор кода ограничен по IP и глобально.
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentEnrollments, agents } from '../db/schema'
import { encryptSecret, randomToken } from '../lib/crypto'
import { getEnv } from '../env'
import { logActivity } from '../activity'

export const ENROLL_TTL_MS = 15 * 60_000
export const ENROLL_CODE = /^[A-Za-z0-9_-]{32}$/
export const AGENT_FILES = [
  'hrh-ops-agent.py',
  'hrh_ops_collect.py',
  'hrh_ops_edge.py',
  'hrh_ops_vpn.py',
  'hrh-ops-vpnd.py',
  'hrh-ops-agent.service',
  'hrh-ops-vpn.service',
] as const
export type AgentFile = (typeof AGENT_FILES)[number]

const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')

/** Файлы агента из каталога agent/ (в образе — /app/agent). */
export function agentFile(name: AgentFile): Buffer {
  return readFileSync(resolve(process.cwd(), 'agent', name))
}

/** Адрес консоли для скрипта: https, или http только на localhost (разработка). */
export function installBaseUrl(): string | null {
  const url = getEnv().publicUrl.replace(/\/+$/, '')
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return url
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return url
  } catch {
    return null
  }
  return null
}

export function installCommand(code: string): string | null {
  const base = installBaseUrl()
  return base ? `curl -fsSL ${base}/agent/install.sh | sudo OPS_ENROLL_CODE=${code} bash` : null
}

export async function createEnrollment(agentId: string, by: string): Promise<{ code: string; expiresAt: number }> {
  const code = randomBytes(24).toString('base64url')
  const now = Date.now()
  const db = getDb()
  // Новый код отменяет прежние неиспользованные коды этого агента.
  await db.delete(agentEnrollments).where(and(eq(agentEnrollments.agentId, agentId), isNull(agentEnrollments.usedAt)))
  await db.insert(agentEnrollments).values({ codeHash: sha256(code), agentId, expiresAt: new Date(now + ENROLL_TTL_MS), createdBy: by, createdAt: new Date(now) })
  return { code, expiresAt: now + ENROLL_TTL_MS }
}

/**
 * Обменять код на секрет. Код гасится условным UPDATE (used_at IS NULL и не истёк) — два
 * одновременных обмена не получат два секрета. null — кода нет, истёк или уже использован.
 */
export async function redeemEnrollment(code: string, ip: string): Promise<{ agentId: string; secret: string } | null> {
  if (!ENROLL_CODE.test(code)) return null
  const db = getDb()
  const [row] = await db
    .update(agentEnrollments)
    .set({ usedAt: new Date(), usedFromIp: ip.slice(0, 64) })
    .where(and(eq(agentEnrollments.codeHash, sha256(code)), isNull(agentEnrollments.usedAt), gt(agentEnrollments.expiresAt, new Date())))
    .returning()
  if (!row) return null
  const secret = `hrhops_${randomToken(32)}`
  const [agent] = await db
    .update(agents)
    .set({ secretEnc: encryptSecret(secret), secretHint: secret.slice(-4), lastRequestTs: 0 })
    .where(eq(agents.id, row.agentId))
    .returning({ name: agents.name })
  if (!agent) return null
  await logActivity('agent', `Агент «${agent.name}» подключён по одноразовому коду с ${ip || 'неизвестного адреса'}`, row.createdBy, `/infrastructure/${row.agentId}`)
  return { agentId: row.agentId, secret }
}

/** Содержимое /etc/hrh-ops-agent.env для подключённого агента. */
export function enrolledEnv(agentId: string, secret: string): string {
  return [
    '# Создано установщиком по одноразовому коду консоли. Права 600, владелец root.',
    `OPS_CONSOLE_URL=${installBaseUrl() ?? getEnv().publicUrl}`,
    `OPS_AGENT_ID=${agentId}`,
    `OPS_AGENT_SECRET=${secret}`,
    'OPS_AGENT_INTERVAL=15',
    '',
  ].join('\n')
}

/** Скрипт установки: адрес консоли и контрольные суммы файлов — вшиты на момент запроса. */
export function installScript(base: string): string {
  const sums = AGENT_FILES.map((f) => `${sha256(agentFile(f))}  ${f}`).join('\n')
  const proto = base.startsWith('https://') ? "--proto '=https' --tlsv1.2" : ''
  return `#!/usr/bin/env bash
# HR Helper Ops — установка агента по одноразовому коду из консоли (Настройки → Агенты → «Команда установки»).
# Что делает: скачивает файлы агента с ${base} (сверяя sha256), меняет код на секрет агента,
# пишет /etc/hrh-ops-agent.env (600, root) и запускает службу hrh-ops-agent. Код действует 15 минут и один раз.
set -euo pipefail
CONSOLE_URL='${base}'
CURL="curl -fsS ${proto} --max-time 30"
[[ $EUID -eq 0 ]] || { echo "нужен root: curl ... | sudo OPS_ENROLL_CODE=... bash" >&2; exit 1; }
[[ "\${OPS_ENROLL_CODE:-}" =~ ^[A-Za-z0-9_-]{32}$ ]] || { echo "нет или неверный OPS_ENROLL_CODE — возьмите команду в консоли заново" >&2; exit 1; }
command -v python3 >/dev/null || { echo "нужен python3" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "нужен sha256sum (coreutils)" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "нужен systemd" >&2; exit 1; }
command -v docker >/dev/null || echo "внимание: docker не найден — контейнеры собираться не будут"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
for f in ${AGENT_FILES.join(' ')}; do
  $CURL "$CONSOLE_URL/agent/files/$f" -o "$tmp/$f"
done
( cd "$tmp" && sha256sum -c --quiet - <<'SUMS'
${sums}
SUMS
) || { echo "контрольные суммы файлов агента не сошлись — установка прервана" >&2; exit 1; }

env_tmp="$tmp/hrh-ops-agent.env"
$CURL -X POST -H 'Content-Type: application/json' --data "{\\"code\\":\\"$OPS_ENROLL_CODE\\"}" "$CONSOLE_URL/api/agent/enroll" -o "$env_tmp" \\
  || { echo "консоль не приняла код: он истёк, уже использован или неверен — получите новую команду" >&2; exit 1; }
grep -q '^OPS_AGENT_SECRET=hrhops_' "$env_tmp" || { echo "консоль вернула неожиданный ответ" >&2; exit 1; }

id hrh-ops >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin hrh-ops
install -d -m 755 /opt/hrh-ops
install -m 755 "$tmp/hrh-ops-agent.py" /opt/hrh-ops/hrh-ops-agent.py
install -m 644 "$tmp/hrh_ops_collect.py" /opt/hrh-ops/hrh_ops_collect.py
install -m 644 "$tmp/hrh_ops_edge.py" /opt/hrh-ops/hrh_ops_edge.py
install -m 644 "$tmp/hrh_ops_vpn.py" /opt/hrh-ops/hrh_ops_vpn.py
install -m 755 "$tmp/hrh-ops-vpnd.py" /opt/hrh-ops/hrh-ops-vpnd.py
install -m 644 "$tmp/hrh-ops-agent.service" /etc/systemd/system/hrh-ops-agent.service
# Сборщик VPN, выключенный владельцем (systemctl mask hrh-ops-vpn), переподключение не трогает: юнит — ссылка на /dev/null.
vpn_was="$(systemctl is-enabled hrh-ops-vpn 2>/dev/null || true)"
[[ "$vpn_was" == masked* ]] || install -m 644 "$tmp/hrh-ops-vpn.service" /etc/systemd/system/hrh-ops-vpn.service
# Переподключение: id и секрет — новые, остальные настройки хоста (маски перезапуска, BUSINESS_CMDS,
# nginx, адрес консоли — на сервере с консолью это loopback, а не публичный адрес) сохраняются.
if [[ -f /etc/hrh-ops-agent.env ]]; then
  cp -p /etc/hrh-ops-agent.env "/etc/hrh-ops-agent.env.bak.$(date +%s)"
  merged="$tmp/merged.env"
  grep -E '^OPS_AGENT_(ID|SECRET)=' "$env_tmp" > "$merged"
  grep -v -E '^OPS_AGENT_(ID|SECRET)=' /etc/hrh-ops-agent.env >> "$merged" || true
  for k in OPS_CONSOLE_URL OPS_AGENT_INTERVAL; do
    grep -q "^$k=" "$merged" || grep "^$k=" "$env_tmp" >> "$merged" || true
  done
  env_tmp="$merged"
fi
install -m 600 -o root -g root "$env_tmp" /etc/hrh-ops-agent.env
systemctl daemon-reload
systemctl enable hrh-ops-agent >/dev/null
systemctl restart hrh-ops-agent
# Сборщик WireGuard (root, только чтение wg и conntrack) — только там, где есть интерфейс WireGuard.
if [[ "$vpn_was" == masked* ]]; then
  echo "сборщик VPN выключен на этом хосте (systemctl mask) — оставлен выключенным"
elif command -v wg >/dev/null && [[ -n "$(wg show interfaces 2>/dev/null)" ]]; then
  systemctl enable hrh-ops-vpn >/dev/null
  systemctl restart hrh-ops-vpn
  echo "WireGuard найден — запущен сборщик VPN (hrh-ops-vpn)"
fi
echo "агент установлен и запущен — консоль покажет первый отчёт в течение ~15 секунд"
echo "журнал: journalctl -u hrh-ops-agent -n 50"
`
}
