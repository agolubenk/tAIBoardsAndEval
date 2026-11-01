/** Отчёт агента → плоский набор метрик хоста (то, по чему работают правила и графики). */
import type { AgentReport } from '../../shared/agent-contract'
import { vpnSamples } from './vpn'

const round = (v: number) => Math.round(v * 100) / 100

export function extractHostSamples(r: AgentReport): Map<string, number> {
  const m = new Map<string, number>()
  const put = (k: string, v: number | undefined | null) => {
    if (typeof v === 'number' && Number.isFinite(v)) m.set(k, round(v))
  }
  put('cpu_pct', r.cpu?.pct)
  put('load1', r.cpu?.load1)
  if (r.memory?.usedMb !== undefined && r.memory.totalMb) {
    put('mem_used_mb', r.memory.usedMb)
    put('mem_pct', (r.memory.usedMb / r.memory.totalMb) * 100)
  }
  put('swap_used_mb', r.memory?.swapUsedMb)
  const diskPcts = r.disks.filter((d) => d.totalGb > 0).map((d) => (d.usedGb / d.totalGb) * 100)
  if (diskPcts.length) put('disk_pct', Math.max(...diskPcts))
  const inodes = r.disks.map((d) => d.inodePct).filter((v): v is number => typeof v === 'number')
  if (inodes.length) put('inode_pct', Math.max(...inodes))
  put('net_rx_bps', r.network?.rxBytesPerSec)
  put('net_tx_bps', r.network?.txBytesPerSec)
  put('net_errors', r.network?.errors)
  if (r.nginx) {
    put('nginx_rpm', r.nginx.requestsPerMin)
    put('nginx_4xx_rpm', r.nginx.errors4xxPerMin)
    put('nginx_5xx_rpm', r.nginx.errors5xxPerMin)
  }
  // 1 — docker ответил агенту, 0 — нет (зависший dockerd, нет CLI): правило «Docker не отвечает».
  if (r.containers || r.dockerError) put('docker_ok', r.dockerError ? 0 : 1)
  if (r.containers) {
    put('containers_running', r.containers.filter((c) => c.state === 'running').length)
    put('containers_total', r.containers.length)
  }
  for (const [k, v] of Object.entries(r.business ?? {})) put(`biz_${k}`.slice(0, 64), v)
  // Сколько команд BUSINESS_CMDS упало в последнем замере: правило «Бизнес-метрики не считаются».
  if (r.businessFailed) put('biz_failed', r.businessFailed.length)
  vpnSamples(r.vpn, put)
  return m
}
