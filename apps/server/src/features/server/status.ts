import os from 'node:os'
import type { ServerStatus } from '@agent-gateway/shared'
import { SERVER_PROTOCOL_VERSION, SERVER_VERSION } from '../../protocol.js'

/** 主机运行状态快照。纯函数便于测试。 */
export function serverStatusSnapshot(hostId: string): ServerStatus {
  const totalBytes = os.totalmem()
  const freeBytes = os.freemem()
  const usagePercent = totalBytes === 0 ? 0 : Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10
  const load = os.loadavg()
  const load1 = load[0] ?? 0
  const load5 = load[1] ?? 0
  const load15 = load[2] ?? 0
  return {
    hostId,
    version: SERVER_VERSION,
    protocolVersion: SERVER_PROTOCOL_VERSION,
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    loadAvg: [load1, load5, load15],
    memory: { totalBytes, freeBytes, usagePercent },
    gateway: { pid: process.pid, rssBytes: process.memoryUsage().rss },
    uptimeSeconds: Math.floor(os.uptime())
  }
}
